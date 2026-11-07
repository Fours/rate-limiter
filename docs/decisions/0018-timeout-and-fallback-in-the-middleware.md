# 0018. The timeout and fallback live in the middleware, around any algorithm

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 4

## Context

[0010](0010-fail-open-with-local-fallback.md) decided to fail open: give each check 50 ms, and answer from an in-memory limiter when Redis fails. That leaves how: where the timeout sits, what happens to a check that outlives it, which algorithm answers instead, and what the Redis client itself does during an outage, since a client that queues commands turns every failure into a wait.

## Decision

- **In the middleware.** `rateLimit` races every `algorithm.check` against `timeoutMs` (default 50). A timeout, a rejection or a synchronous throw falls back. It's the same for all five algorithms and for a caller's own, so the middleware still doesn't bend to one algorithm, and it's the one place that knows where a decision came from, which the milestone 4 hooks need.
- **A late result is dropped, not cancelled.** Neither Redis client can cancel a command already sent. A timed-out check may still use a token in Redis when it lands, which can only make the limit stricter. Its rejection is handled, so it never becomes an `unhandledRejection`.
- **The fallback is always the in-memory token bucket,** the only in-memory algorithm, at `max(1, ceil(limit / instances))` per instance, where `fallback: { instances }` defaults to 1. The headers report that scaled limit, since `RateLimit-Remaining` counts against it. The bucket is created on the first failure, so a limiter whose Redis never fails holds no second bucket or sweep timer, and `close()` stops it.
- **`fallback: false`** sends the error to Express's error handler, or a `RateLimitTimeoutError` on a timeout, for callers who would rather fail closed. The timeout still applies, so failing closed is bounded too.
- **Only the check falls back.** Errors from `identify`, `tier` and rule matching are bugs in the caller's code, not outages, and still go to `next(err)`.
- **Turn off the client's offline queue:** `enableOfflineQueue: false` for ioredis, `disableOfflineQueue: true` for node-redis. The README says so.

## Alternatives considered

| Option | Why not |
| --- | --- |
| An `Algorithm` wrapper, `withFallback(algorithm, …)` | Easy to forget, hooks configured in two places, and `onDecision` couldn't tell a fallback decision from a primary one without a new field on `Decision` |
| The client's own timeout (ioredis `commandTimeout`) | Client-specific, absent from the `RedisScriptClient` interface (0013), and still needs a fallback around it |
| A fallback of the same algorithm as the primary | Only the token bucket exists in memory, and during an outage approximate is enough (0010) |
| Fallback off by default | Turns a Redis outage into an API outage, the thing 0010 decided against |
| No timeout with `fallback: false` | A hung Redis would then hang every request |

## Evidence

**What the clients do** ([data/0018-client-probe-2026-11-06](data/0018-client-probe-2026-11-06/results.md)). ioredis 6.0.0 and node-redis 6.3.1 against Redis 7.4.12 in Docker:

| Settings | Redis killed, or never there | Redis paused |
| --- | --- | --- |
| Default (offline queue on) | Commands queue until Redis is back: every check would wait the full timeout | Commands hang until `unpause`, then all run |
| Offline queue off | Errors in 0.1 ms or less: the fallback answers at once | The same: commands hang, then all run |

So turning off the offline queue makes a dead Redis cost nothing, but nothing on the client side helps with a hung one: only the timeout bounds it, and each check sent while it hangs still runs when Redis comes back.

**Tests:**

- `test/timeout.test.ts`: a hanging call times out at exactly `timeoutMs`, a rejection or a throw is reported at once, no timer is left behind, and a rejection after the timeout is never unhandled
- `test/fallback.test.ts`: `ceil(limit / instances)`, never below 1, and the bucket is created only on first use
- `test/middleware.fallback.test.ts`, through supertest: the default and a custom `timeoutMs`, the scaled headers, `fallback: false`, `RateLimitTimeoutError`, caller errors still reaching `next(err)`, and startup validation
- The middleware contract suite: a failed check answered by the fallback, for the in-memory bucket and all five Redis algorithms
- `test/integration/fallback.test.ts`, with both clients and the offline queue off: a closed port falls back without waiting for the timeout. A Redis that hangs (a pausable TCP proxy in front of the test Redis) falls back after 50 ms. When it answers again, the primary is back, and the timed-out check has used a token in Redis, as described above.

## Consequences

- While Redis hangs rather than refusing connections, every limited request waits `timeoutMs` before the fallback answers, and the commands sent meanwhile pile up inside the client until Redis comes back. The chaos test in milestone 4, T4 measures this, and decides whether a circuit breaker is worth adding.
- Fallback buckets start full and per instance, so an outage begins with each client able to send another `limit / instances` to every instance. 0010's chaos evidence measures that overshoot.
- The README has to recommend client settings, because the library can't set them: the caller brings the client (0013).
