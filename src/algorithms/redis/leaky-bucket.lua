-- Leaky bucket as a GCRA (decision 0014): requests evenly spaced, one per interval
-- T = windowMs / limit. One "theoretical arrival time" (TAT) per client: a request is allowed
-- once its slot has arrived, and each allowed request moves the TAT on by T. A burst b lets a
-- slot be taken up to (b - 1) * T early, so b requests can arrive at once (decision 0022). The
-- default, 1, is burst-free.
-- Arguments, reply, rl_now and rl_claim: see prelude.lua. ARGV[4] is the burst, empty for none.
--
-- T is rarely a whole number of ms (7 per minute is 8571.43 ms), and now * limit can exceed 2^53,
-- so the TAT is kept as whole ms (`tat`) plus a remainder in 1/limit ms (`rem`, 0 <= rem < limit).
-- Every value is an exact integer, and the slots never drift.

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local burst = 1
if ARGV[4] ~= nil and ARGV[4] ~= '' then
  burst = tonumber(ARGV[4])
end
-- How early a slot may be taken, in 1/limit ms: (burst - 1) * T. Exact, since
-- burst * windowMs <= 2^51 (rule validation).
local tolerance = (burst - 1) * window

-- floor(a / b) for integers. Exact without a correction: rule validation keeps |a| below 2^51,
-- and for |a| < 2^53 the rounding error in a / b is less than 1 / b, the least distance from a
-- non-integer quotient to an integer, so the floor can't land on the wrong side of one. A
-- correction step here was found by mutation testing to be unreachable.
local function floordiv(a, b)
  return math.floor(a / b)
end

local now = rl_now(ARGV[3])
rl_claim(key, 'hash', 'leaky-bucket')

-- T = step_ms + step_rem / limit
local step_ms = math.floor(window / limit)
local step_rem = window - step_ms * limit

local stored = redis.call('HMGET', key, 'tat', 'rem', 'limit', 'window', 'last')
local tat, rem = now, 0
if stored[1] then
  -- Time only moves forward, so a clock that steps back can't reach an earlier slot.
  now = math.max(now, tonumber(stored[5]))
  tat, rem = tonumber(stored[1]), tonumber(stored[2])
  if tonumber(stored[3]) ~= limit or tonumber(stored[4]) ~= window then
    -- The remainder is in the old rule's units. Round the TAT up, so a rule change keeps the
    -- debt and never brings the next slot earlier.
    if rem > 0 then
      tat = tat + 1
    end
    rem = 0
  end
end
-- A bucket that drained in the past restarts from now: no saved-up burst.
if tat < now then
  tat, rem = now, 0
end

-- Allowed if this request's slot, brought forward by the tolerance, starts within the current
-- millisecond. With a ms clock, a strict "slot has fully arrived" would cap every rule at one
-- request per ms; this way a rule faster than that (10 per 4 ms) still gets its share. In
-- 1/limit ms units the slot starts at tat * limit + rem - tolerance, and this millisecond ends
-- at (now + 1) * limit. Denied requests don't move the TAT.
local allowed = 0
if (tat - now) * limit + rem - tolerance < limit then
  allowed = 1
  tat = tat + step_ms
  rem = rem + step_rem
  if rem >= limit then
    rem = rem - limit
    tat = tat + 1
  end
end

-- How many more slots start within this millisecond, brought forward by the tolerance: the
-- burst left, plus any extra for a rule faster than one per ms. In 1/limit ms units, slot j
-- starts at tat * limit + rem - tolerance + j * window.
local room = (now + 1 - tat) * limit - rem + tolerance
local remaining = 0
if room > 0 then
  -- ceil(room / window): room can be as large as burst * windowMs.
  remaining = -floordiv(-room, window)
end

-- Allowed: until fully drained, when the TAT (with its remainder) is behind us (0003).
-- Denied: until the next slot starts.
local drained = tat - now
if rem > 0 then
  drained = drained + 1
end
local resetMs = drained
if allowed == 0 then
  -- The first ms at which the next slot, brought forward, starts.
  resetMs = tat + floordiv(rem - tolerance, limit) - now
end

redis.call('HSET', key, 'alg', 'leaky-bucket', 'tat', tat, 'rem', rem, 'limit', limit,
  'window', window, 'last', now)
-- A drained bucket is the same as no key.
redis.call('PEXPIRE', key, math.max(1, drained))

return {allowed, remaining, resetMs}
