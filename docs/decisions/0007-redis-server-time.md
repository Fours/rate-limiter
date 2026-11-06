# 0007. Use Redis `TIME` inside scripts, not app time

- **Status:** Proposed
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

Time-based algorithms compare "now" with stored timestamps. If each app instance sends its own clock, skew between instances adds or removes tokens.

## Decision

Scripts read `redis.call('TIME')` for the current time. In-memory algorithms take an injected `Clock`.

Production code never sends a timestamp. Each script does take an optional time override as its last argument, so tests can drive Redis scripts with `FakeClock`. Only the internal factory, `createRedisAlgorithm(script, name, { client, clock })` in `src/algorithms/redis/factory.ts`, can set it, through a small `…ForTest` wrapper per algorithm. Neither is exported from `src/index.ts`, and the public factories pass on only the client, so they always send the override empty.

## Alternatives considered

| Option | Why not |
| --- | --- |
| The app sends `Date.now()` | Clock skew between instances changes the limit |
| Trusting NTP to keep app clocks in step | Reduces skew but doesn't remove it, and the limiter can't check it |
| No override: tests control time through small windows and real waits | Slow and flaky, and AGENTS.md bans real sleeps in tests |
| A `clock` option on the public factories | Lets production code opt back into app time by accident |

## Evidence

To gather in milestone 2: a test where instances report clocks that are off by ±2 s gives the same decisions when using Redis time, and different decisions when using app time.

## Consequences

Older Redis versions need script effects replication when scripts call `TIME`. Redis 7 does this by default, and a probe on Redis 7.4 confirmed that a script can read `TIME` and then write. Redis 7 or later is required.

The override is a path in every script that production never takes, so one test must run without it and show the scripts really use `TIME`. The skew test above does that. The internal factory has to stay out of the public API, which the milestone 2 Definition of done checks.
