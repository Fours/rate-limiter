-- Sliding window counter: two counts per client, this window's and the previous one's, with the
-- previous window's requests assumed spread evenly across it. Cheap and close to exact, but an
-- estimate (0008). Windows are aligned to the epoch.
-- Arguments, reply, rl_now and rl_claim: see prelude.lua.
--
-- With W = windowMs and e = ms since the current window began, the estimate in integer units is
--   prev * (W - e) + curr * W
-- compared against limit * W, so there's no float rounding (every value stays below 2^53).

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local W = tonumber(ARGV[2])

local now = rl_now(ARGV[3])
rl_claim(key, 'hash', 'sliding-window-counter')

local stored = redis.call('HMGET', key, 'start', 'window', 'curr', 'prev', 'last')
local curr, prev = 0, 0
if stored[1] then
  -- Time only moves forward, so a clock that steps back can't reach an earlier window.
  now = math.max(now, tonumber(stored[5]))
end
local start = math.floor(now / W) * W

if stored[1] then
  local old_start, old_window = tonumber(stored[1]), tonumber(stored[2])
  local old_curr, old_prev = tonumber(stored[3]), tonumber(stored[4])
  if old_window ~= W then
    -- windowMs changed, so the old windows don't line up with the new ones. While the old state
    -- still matters, count all of it in the current window: the old estimate was at most
    -- prev + curr, so this never allows more than before.
    if now < old_start + 2 * old_window then
      curr = old_curr + old_prev
    end
  elseif old_start == start then
    curr, prev = old_curr, old_prev
  elseif old_start == start - W then
    -- One window on: this window's count becomes the previous one.
    prev = old_curr
  end
  -- Two or more windows on: both counts have aged out.
end

local e = now - start
local function estimate(c)
  return prev * (W - e) + c * W
end

-- Strict: allow only if the estimate including this request fits. (The common "estimate < limit"
-- rule lets one request push the estimate over the limit.) Only allowed requests count.
local allowed = 0
if estimate(curr + 1) <= limit * W then
  curr = curr + 1
  allowed = 1
end

-- How many more requests fit right now. Below 0 after a limit shrank, so clamp.
local remaining = math.max(0, math.floor((limit * W - estimate(curr)) / W))

local resetMs
if allowed == 1 then
  -- Fully restored once both counts have aged out: the end of the next window (0003).
  resetMs = 2 * W - e
else
  -- The smallest wait after which one more request fits, if nothing else arrives meanwhile.
  -- 1. Later in this window, as the previous window's share shrinks.
  if curr + 1 <= limit and prev > 0 then
    local t = W - e - math.floor((limit - curr - 1) * W / prev)
    if t >= 1 and e + t < W then
      resetMs = t
    end
  end
  if resetMs == nil then
    if curr == 0 then
      -- 2a. The next window starts with nothing counted.
      resetMs = W - e
    else
      -- 2b. In the next window, this window's count becomes the previous one and shrinks.
      local fits = math.floor((limit - 1) * W / curr)
      if fits >= 1 then
        resetMs = W - e + math.max(0, W - fits)
      else
        -- 3. Not before the window after that, when both counts have aged out. This happens
        -- with a limit of 1, or a count above a limit that shrank.
        resetMs = 2 * W - e
      end
    end
  end
end

redis.call('HSET', key, 'alg', 'sliding-window-counter', 'start', start, 'window', W,
  'curr', curr, 'prev', prev, 'last', now)
-- Both counts have aged out at the end of the next window. That's more than W, so at least 1.
redis.call('PEXPIRE', key, 2 * W - e)

return {allowed, remaining, resetMs}
