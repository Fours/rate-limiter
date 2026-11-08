-- Token bucket. The same maths as src/algorithms/token-bucket.ts: state is kept in integer
-- "units", where one token is windowMs units and the bucket refills `limit` units per ms, so
-- every value is exact (limit * windowMs and burst * windowMs <= 2^51, checked by rule
-- validation). It holds up to `burst` tokens, `limit` by default (decision 0022).
-- Arguments, reply, rl_now and rl_claim: see prelude.lua. ARGV[4] is the burst, empty for none.

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local burst = limit
if ARGV[4] ~= nil and ARGV[4] ~= '' then
  burst = tonumber(ARGV[4])
end

local now = rl_now(ARGV[3])
rl_claim(key, 'hash', 'token-bucket')

-- Refill for the time since `last`. `last` only moves forward, so a clock that steps back and
-- then returns can't refill the same span twice.
local function refill(units, last, lim, win, cap)
  local elapsed = math.max(0, now - last)
  return math.min(cap * win, units + elapsed * lim), math.max(last, now)
end

local capacity = burst * window
local stored = redis.call('HMGET', key, 'units', 'last', 'limit', 'window', 'burst')
local units, last
if not stored[1] then
  -- A new key starts full.
  units, last = capacity, now
else
  units, last = tonumber(stored[1]), tonumber(stored[2])
  local oldLimit, oldWindow = tonumber(stored[3]), tonumber(stored[4])
  -- State written before bursts existed has no burst field: its capacity was its limit.
  local oldBurst = tonumber(stored[5]) or oldLimit
  if oldLimit ~= limit or oldWindow ~= window or oldBurst ~= burst then
    -- The rule changed under this key, or two rules share it, as in a rolling deploy (0031).
    units, last = refill(units, last, oldLimit, oldWindow, oldBurst)
    if units == oldBurst * oldWindow then
      -- Full under the old rule, which is the same as no key: the PEXPIRE below would drop it
      -- by now if Redis got there first. So it starts full under the new rule too, and the
      -- answer doesn't depend on when the key expires.
      units = capacity
    else
      -- Carry over the tokens, the fraction of the next one included, rounded down to a unit
      -- and capped at the new burst: never more than the client had, nor than the new rule
      -- holds. Dropping the fraction would lock out a client whose checks alternate between
      -- two rules.
      local tokens, part = math.floor(units / oldWindow), units % oldWindow
      local fraction = 0
      -- part * window / oldWindow is exact only while oldWindow * window fits in 2^53.
      if oldWindow * window <= 9007199254740992 then
        fraction = math.floor(part * window / oldWindow)
      end
      units = math.min(capacity, tokens * window + fraction)
    end
  end
end
units, last = refill(units, last, limit, window, burst)

local allowed = 0
if units >= window then
  units = units - window
  allowed = 1
end

-- Allowed: time until full. Denied: time until the next token (decision 0003).
local missing
if allowed == 1 then
  missing = capacity - units
else
  missing = window - units
end
local resetMs = math.ceil(missing / limit)
local remaining = math.floor(units / window)

redis.call('HSET', key, 'alg', 'token-bucket', 'units', units, 'last', last,
  'limit', limit, 'window', window)
-- The burst is stored only when it isn't the limit, so a rule without one stores exactly what it
-- did before bursts existed, and the same number of bytes (decision 0008's memory figures).
if burst ~= limit then
  redis.call('HSET', key, 'burst', burst)
elseif stored[5] then
  redis.call('HDEL', key, 'burst')
end
-- A full bucket is the same as no key, so the state only matters until it's full again.
-- After any check the bucket is at least one unit short, so this is at least 1 ms.
redis.call('PEXPIRE', key, math.ceil((capacity - units) / limit))

return {allowed, remaining, resetMs}
