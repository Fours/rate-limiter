# Probe: the shipped Lua scripts in wasmoon, against real Redis

Run before milestone 5's spec, to decide whether the browser demo can run the exact scripts the package ships.

## Setup

- Apple M5 Pro, Node 25.8.2 on the host, at commit `b4d11db`
- wasmoon 1.16.0 (Lua 5.4 compiled to WebAssembly, MIT), in a scratch folder, not the repo
- Redis 7.4.12 (`redis:7-alpine`, the test Redis on port 6390), through ioredis 6.0.0
- `shim.mjs`: a stand-in for the 13 Redis commands the scripts call (`TIME`, `TYPE`, `DEL`, `PEXPIRE`, `HGET`, `HMGET`, `HSET`, `ZSCORE`, `ZADD`, `ZCOUNT`, `ZREMRANGEBYSCORE`, `ZRANGEBYSCORE`, `ZRANGE`). It stores values as strings and turns Lua number arguments into strings with JS `String()`, the shortest form that round-trips, which matches Redis 7's `fpconv_dtoa`. Replies are truncated to integers, as Redis does.
- `compare.mjs`: random request sequences, seeded, through both. Each step sends the scripts' test-only time override (`ARGV[3]`), so both see the same time. On Redis each check runs in one `MULTI` with `PTTL` and `PERSIST`, so no key expires on real time mid-sequence (the leaky bucket flake of milestone 4). The stand-in's expiry is off for the comparison.
- Commands: `node compare.mjs 200 100` (200 scenarios × 5 algorithms × 100 steps) and `node speed.mjs`. The scripts read the Lua from the repo by absolute path, so they need adjusting to rerun elsewhere. They never flush: every key is unique to the run and deleted at the end.

Sequences include several requests in one millisecond, steps landing exactly on window edges, the clock stepping back, a rule's limit and window changing under a key, and another algorithm taking over a key (0016).

## Results

**100,000 checks, 0 mismatches**, comparing for each check the reply, the whole stored state (`HGETALL` or `ZRANGE … WITHSCORES`), and the `PEXPIRE` the script set against `PTTL`.

Breaking the stand-in on purpose (6,000 checks each, 20 scenarios × 60 steps):

| Break | Mismatches |
| --- | --- |
| Numbers written the Lua 5.4 way (`"1.0"`) | 4,798 |
| Replies not truncated to integers | 6,000 |
| `ZRANGE` negative indexes wrong | 3,414 |
| Sorted-set ties ordered by member backwards | 655 |
| `ZCOUNT`/`ZRANGEBYSCORE` ignore an exclusive `(` bound | 0: unobservable, since `ZREMRANGEBYSCORE` removes every entry at or before the cutoff first |
| `PEXPIRE` of 0 or less doesn't delete | 0: unobservable, since no script ever sets one |

Lua 5.1 vs 5.4: the scripts already avoid the differences. The sliding window log formats scores and members with `string.format('%.0f')`, and every other number goes to Redis as an argument, which the stand-in formats in JS.

Speed in Node, through the stand-in with Redis `TIME` (no override), 20,000 checks each: 69 µs (token bucket) to 93 µs (sliding window counter) per check, 10,800 to 14,500 a second. Keys expire on simulated time.

Size: `glue.wasm` 272 KB (111 KB gzipped), `index.js` 152 KB (39 KB gzipped).

Not tested: loading wasmoon through Vite in a real browser.
