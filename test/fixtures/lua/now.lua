-- For test/integration/prelude.test.ts: the prelude's rl_now, between two readings of TIME.
local function ms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local before = ms()
local now = rl_now(ARGV[1])
local after = ms()
return {before, now, after}
