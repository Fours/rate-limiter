# 0006. Each check is one Lua script via `EVALSHA`

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

With several app instances, a check that reads the count and then writes it back lets two instances both take the last token.

## Decision

Each algorithm's check is a single Lua script. The script is loaded once with `SCRIPT LOAD` and called with `EVALSHA`, reloading it on `NOSCRIPT`. Redis runs scripts one at a time, so the read and write happen together. The script returns `[allowed, remaining, resetMs]`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `GET` then `SET` | Races across instances |
| `WATCH`/`MULTI` transactions | Retries under contention, and costs more round trips |
| `INCR` with `EXPIRE` | Works for a fixed window only, not token buckets or sliding windows |
| Redis modules (for example redis-cell) | Not on managed Redis, and less to show |

## Evidence

`test/integration/distributed.test.ts` sends 200 concurrent checks over 4 separate connections (two through `ioredis`, two through `node-redis`) against a rule of 50 per 10^12 ms, using the public factories and Redis `TIME`:

| Implementation | Allowed |
| --- | --- |
| Token bucket, fixed window, sliding window log, sliding window counter (Lua) | exactly 50 |
| Leaky bucket (Lua, no burst by design, [0014](0014-leaky-bucket-as-gcra.md)) | exactly 1 |
| Naive token bucket in the test file: read in one round trip, write in the next | over 50 (asserted) |

Before writing the test, a probe ran the Lua token bucket and the naive version 10 times each under the same load: the Lua script allowed 50 every time, and the naive version allowed **200 every time**, because every read landed before any write. Setup: Apple M5 Pro, Node 25.8.2, Redis 7.4.12 in Docker (`redis:7-alpine`), run with `npm run test:integration`. CI runs the same test on Node 22 and 24 against a `redis:7-alpine` service.

Each algorithm also passes the behaviour suite, a reference model step for step, and the milestone 1 middleware tests (see [0001](0001-async-algorithm-interface.md)).

## Consequences

The Lua scripts are code that needs its own tests. Redis Cluster would need all keys for one check in the same hash slot, which is fine because each check uses one key.
