-- Shared by every rate-limit script. loadScript puts this in front of each algorithm's file, so
-- each check is still a single script, run atomically.
--
-- Every script is called the same way:
--   KEYS[1]  storage key
--   ARGV[1]  limit
--   ARGV[2]  windowMs
--   ARGV[3]  time override in ms: empty in production, set only by tests (decision 0007)
-- and returns {allowed (0 or 1), remaining, resetMs}, all integers. Never put nil in the
-- result: it silently shortens the reply.

-- The current time in ms: Redis TIME, unless the test-only override is set.
local function rl_now(override)
  if override ~= '' then
    return tonumber(override)
  end
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

-- State another algorithm left under this key, after the app switched algorithms, would fail
-- with WRONGTYPE or be misread. Delete it so the client starts fresh (decision 0016).
-- `kind` is the Redis type this algorithm stores. A hash is tagged with an `alg` field; a sorted
-- set, which has no fields, is tagged with a member named `tag`.
local function rl_claim(key, kind, tag)
  local actual = redis.call('TYPE', key).ok
  if actual == 'none' then
    return
  end
  local ours
  if actual ~= kind then
    ours = false
  elseif kind == 'hash' then
    ours = redis.call('HGET', key, 'alg') == tag
  else
    ours = redis.call('ZSCORE', key, tag) ~= false
  end
  if not ours then
    redis.call('DEL', key)
  end
end
