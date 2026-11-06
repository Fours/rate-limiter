-- Token bucket. The same maths as src/algorithms/token-bucket.ts: state is kept in integer
-- "units", where one token is windowMs units and the bucket refills `limit` units per ms, so
-- every value is exact (limit * windowMs <= 2^53, checked by rule validation).
-- Arguments, reply, rl_now and rl_claim: see prelude.lua.

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local now = rl_now(ARGV[3])
rl_claim(key, 'token-bucket')

-- Refill for the time since `last`. `last` only moves forward, so a clock that steps back and
-- then returns can't refill the same span twice.
local function refill(units, last, lim, win)
  local elapsed = math.max(0, now - last)
  return math.min(lim * win, units + elapsed * lim), math.max(last, now)
end

local capacity = limit * window
local stored = redis.call('HMGET', key, 'units', 'last', 'limit', 'window')
local units, last
if not stored[1] then
  -- A new key starts full.
  units, last = capacity, now
else
  units, last = tonumber(stored[1]), tonumber(stored[2])
  local oldLimit, oldWindow = tonumber(stored[3]), tonumber(stored[4])
  if oldLimit ~= limit or oldWindow ~= window then
    -- The rule changed under this key. Carry over whole tokens only, rounding down, so a
    -- change never grants more than the client already had.
    units, last = refill(units, last, oldLimit, oldWindow)
    units = math.min(limit, math.floor(units / oldWindow)) * window
  end
end
units, last = refill(units, last, limit, window)

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
-- A full bucket is the same as no key, so the state only matters until it's full again.
-- After any check the bucket is at least one unit short, so this is at least 1 ms.
redis.call('PEXPIRE', key, math.ceil((capacity - units) / limit))

return {allowed, remaining, resetMs}
