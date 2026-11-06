# 0006. Each check is one Lua script via `EVALSHA`

- **Status:** Proposed
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

To gather in milestone 2: a test with N concurrent clients across several connections against a limit of L, which must allow exactly L. Run it against a naive `GET`/`SET` version too, to show the overshoot.

## Consequences

The Lua scripts are code that needs its own tests. Redis Cluster would need all keys for one check in the same hash slot, which is fine because each check uses one key.
