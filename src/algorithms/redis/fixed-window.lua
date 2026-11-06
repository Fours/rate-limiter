-- Fixed window: up to `limit` requests per window. Windows are aligned to the epoch, so a client
-- can get up to 2x the limit across a boundary. That weakness is the point of including it: it's
-- the baseline the other algorithms are measured against.
-- Arguments, reply, rl_now and rl_claim: see prelude.lua.

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local now = rl_now(ARGV[3])
rl_claim(key, 'fixed-window')

local stored = redis.call('HMGET', key, 'start', 'end', 'count', 'last')
local window_start, window_end, count
if stored[1] then
  window_start, window_end, count = tonumber(stored[1]), tonumber(stored[2]), tonumber(stored[3])
  -- Time only moves forward, so a clock that steps back can't land in an earlier window with
  -- a fresh count.
  now = math.max(now, tonumber(stored[4]))
end

-- A window, once started, runs to the end it started with. A new windowMs applies from the
-- next window, so changing the rule mid-window never resets the count.
if not stored[1] or now >= window_end then
  window_start = math.floor(now / window) * window
  window_end = window_start + window
  count = 0
end

-- Only allowed requests count.
local allowed = 0
if count < limit then
  count = count + 1
  allowed = 1
end

-- A limit that shrank mid-window can leave count above it.
local remaining = math.max(0, limit - count)
-- Allowed or denied, nothing changes until the window ends (decision 0003).
local resetMs = window_end - now

redis.call('HSET', key, 'alg', 'fixed-window', 'start', window_start, 'end', window_end,
  'count', count, 'last', now)
-- The window's state means nothing once it has ended. now < window_end, so this is at least 1.
redis.call('PEXPIRE', key, window_end - now)

return {allowed, remaining, resetMs}
