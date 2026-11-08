-- Sliding window log: exactly `limit` requests in any windowMs. Keeps one sorted-set entry per
-- allowed request, scored by its time, so it's exact but costs memory per request (0008).
-- Arguments, reply, rl_now and rl_claim: see prelude.lua.

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

-- One extra member does two jobs. Its name is the algorithm tag the start-fresh check looks for
-- (0016), and its score is minus the latest time seen. Request entries have positive scores, so
-- this one sorts first, and the trimming and counting below, which start above 0, skip it.
local TAG = 'alg:sliding-window-log'

-- Scores and range bounds go to Redis as strings. tostring would round them to 14 significant
-- digits, so format integers exactly.
local function int(n)
  return string.format('%.0f', n)
end

local now = rl_now(ARGV[3])
rl_claim(key, 'zset', TAG)

-- Time only moves forward. Denied requests leave no entry, so the newest entry isn't enough:
-- the latest time seen is kept on the tag member.
local seen = redis.call('ZSCORE', key, TAG)
if seen then
  now = math.max(now, -tonumber(seen))
end

-- The window is (now - windowMs, now]. Drop entries at or before its start.
local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', key, 0, int(cutoff))
-- A window longer than the epoch is old would put the cutoff below 0: entries are all above it.
local lower = '(' .. int(math.max(cutoff, 0))
local count = redis.call('ZCOUNT', key, lower, '+inf')

-- Only allowed requests are recorded, as <now>-<entries already at now>. The member must be
-- unique, or ZADD overwrites an entry and the request goes uncounted. Time never moves back,
-- and trimming drops a millisecond's entries all together, so one millisecond's entries are
-- always numbered 0, 1, 2 and so on, whatever windowMs is. The live count isn't unique: after
-- windowMs shrinks, it can fall back to a number already used in this millisecond.
local allowed = 0
if count < limit then
  local same = redis.call('ZCOUNT', key, int(now), int(now))
  redis.call('ZADD', key, int(now), int(now) .. '-' .. int(same))
  count = count + 1
  allowed = 1
end
redis.call('ZADD', key, int(-now), TAG)

local remaining = math.max(0, limit - count)
local resetMs
if allowed == 1 then
  -- Fully restored once this request, the newest entry, has aged out (0003).
  resetMs = window
else
  -- One slot frees when enough entries age out to bring the count below the limit. Usually
  -- that's the oldest; after the limit shrank, it's the entry at position count - limit.
  local entry = redis.call('ZRANGEBYSCORE', key, lower, '+inf', 'WITHSCORES', 'LIMIT', count - limit, 1)
  resetMs = tonumber(entry[2]) + window - now
end

-- The log means nothing once its newest entry has aged out. Every check leaves at least one live
-- entry (allowed adds one; denied needs at least `limit`), so this is at least 1.
local newest = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
redis.call('PEXPIRE', key, tonumber(newest[2]) + window - now)

return {allowed, remaining, resetMs}
