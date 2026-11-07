# 0010. Fail open with a local fallback when Redis is down

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 4

## Context

If Redis is slow or down, the limiter has to decide whether requests are let through (fail open) or refused (fail closed). Refusing everything turns a Redis outage into a full API outage.

## Decision

Fail open. Each check has a 50 ms timeout. On a timeout or error, use an in-memory limiter set to roughly the limit divided by the number of instances, log the event, and call `onFallback`, which increments `ratelimit_fallback_total`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Fail closed | Takes the whole API down with Redis |
| Fail open with no limit | Leaves no protection during the outage, which is when the system is weakest |

## Evidence

Built in milestone 4: the timeout and fallback in the middleware ([0018](0018-timeout-and-fallback-in-the-middleware.md)), and `onFallback` with `prometheusHooks()` ([0019](0019-hook-events.md), [0005](0005-metrics-through-hooks.md)). The middleware doesn't log: the benchmark app logs through `onFallback`, one line each way per outage per instance.

### The chaos test (milestone 4, T4)

On the stack (nginx, three instances with `fallback: { instances: 3 }` and ioredis's offline queue off, one Redis with no persistence), k6 sent 500 req/s for 60 s: 10 heavy clients at 10 req/s each, five times the rule's 20 per 10 s, and 400 req/s of light traffic over 400 clients. About 20 s in, the runner killed Redis (`docker compose kill`) or paused it (`docker compose pause`), and about 20 s later started or unpaused it. Every algorithm, both cases, three runs each: 30 runs. Each cell is the median of three runs. The full tables, with every run, are in the data's `summary.md`.

| Case | Algorithm | Failed requests | End-to-end p99, before / during / after (ms) | Limiter p99, during (ms) | Peak, going away | Peak, coming back | Recovery (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Killed | token bucket | 0 | 1.85 / 1.58 / 1.77 | 0.39 | 41 (2.05×) | 42 (2.10×) | 2,173 |
| Killed | leaky bucket | 0 | 1.81 / 1.68 / 1.85 | 0.40 | 41 (2.05×) | 23 (1.15×) | 2,340 |
| Killed | fixed window | 0 | 1.90 / 1.63 / 1.82 | 0.41 | 50 (2.50×) | 46 (2.30×) | 2,280 |
| Killed | sliding window log | 0 | 1.94 / 1.57 / 1.86 | 0.39 | 39 (1.95×) | 38 (1.90×) | 2,207 |
| Killed | sliding window counter | 0 | 1.85 / 1.61 / 1.82 | 0.41 | 41 (2.05×) | 38 (1.90×) | 2,260 |
| Paused | token bucket | 0 | 1.89 / 53.24 / 1.89 | 52.44 | 41 (2.05×) | 22 (1.10×) | 8 |
| Paused | leaky bucket | 0 | 1.90 / 53.50 / 1.94 | 52.76 | 41 (2.05×) | 22 (1.10×) | 13 |
| Paused | fixed window | 0 | 1.88 / 53.33 / 1.88 | 52.71 | 42 (2.10×) | 33 (1.65×) | 19 |
| Paused | sliding window log | 0 | 1.93 / 53.27 / 2.11 | 52.48 | 39 (1.95×) | 22 (1.10×) | 41 |
| Paused | sliding window counter | 0 | 1.92 / 53.23 / 1.97 | 52.43 | 41 (2.05×) | 22 (1.10×) | 18 |

- **No request failed** in any of the 30 runs: no 5xx and no connection errors, before, during or after the outage, and k6 dropped no iterations. The fallback decided 100% of limited requests during every outage. That's what failing open means.
- **Killed:** the end-to-end p99 during the outage was *lower* than before it (about 1.6 ms against 1.85 ms). With the offline queue off, a check against a dead Redis fails at once, and the in-memory fallback answers without a round trip.
- **Paused:** every check waits out the 50 ms timeout, so the end-to-end p99 rose by about 51 ms, to 53.2 to 53.5 ms, in every run. The spread across runs was under 0.4 ms. Nothing on the client side helps here (0018's probe), so the timeout is what bounds it.
- **Overshoot going away:** about 2× the limit for every algorithm. A heavy client had used its 20 in Redis, then each instance's fallback started with a full bucket of `ceil(20 / 3) = 7`: 20 + 21 = 41. The fixed window reached 2.5× to 2.75× in some runs, when its own boundary burst (up to 2×, [0008](0008-sliding-window-accuracy-vs-cost.md)) fell in the same span.
- **Overshoot coming back:** after a kill, Redis returns empty, since it has no persistence, so a client can get its full limit again on top of what the fallback allowed: about 2×. The leaky bucket stays at 1.15×, because it allows no burst ([0014](0014-leaky-bucket-as-gcra.md)). After a pause, Redis still holds its counts, and the checks that hung during the pause all run when it resumes and use up tokens, so the peak stays near 1.1×.
- **Recovery after a kill takes about 2 s** (1.9 to 2.5 s in every run). That's ioredis reconnecting: the installed ioredis 6.0.0 retries after `min(50 × 2^(n−1), 5000)` ms plus up to 200 ms of jitter, so after a 20 s outage it tries every 5 s, and the primary is back at the first retry after Redis is. It could take up to about 5.2 s. Meanwhile the fallback goes on answering, so this costs accuracy, not availability. The first check after reconnecting also met an empty script cache, so this exercised the `NOSCRIPT` retry under load ([0006](0006-atomic-lua-checks.md)).
- **Recovery after a pause takes 8 to 49 ms:** the connection never dropped, so the first check after `unpause` goes to the primary.
- **No flapping:** after Redis returned, no instance went back to the fallback. The fallback's share after the outage is just the recovery time's share of the phase: about 10% after a kill, about 0.1% after a pause.

Setup: Apple M5 Pro, Docker 29.4.1 (18 CPUs, 8 GiB), Node 22.23.4 in the app image, Redis 7.4.12, nginx 1.31.8, k6 2.3.0, ioredis 6.0.0, at commit `dc4accc` plus T4's changes, so `setup.json` says `uncommittedChanges: true`. Command: `npm run bench -- --scenario chaos`. Raw data: [data/0010-chaos-2026-11-07](data/0010-chaos-2026-11-07/), with every run's requests, fault times and k6 summary. The measures are pure functions in `bench/analysis.ts`, tested with hand-made outages in `test/bench/chaos.test.ts`.

## Consequences

- **Availability:** a Redis outage costs no requests. A dead Redis costs nothing in latency, as long as the client's offline queue is off. A hung one costs `timeoutMs` (50 ms) on every limited request until it answers again.
- **Accuracy:** during an outage, limits are per instance and approximate. The instance count has to be configured (`fallback.instances`); a wrong count makes the outage limit too loose or too strict, and it drifts if instances come and go. Around each change, one client can get up to about 2× its limit in a window: when Redis goes away, the fallback's buckets start full; when it comes back empty, its counts start again.
- **Recovery** depends on the Redis client's reconnect strategy, not the limiter. With ioredis's defaults it took about 2 s here and can take up to about 5 s. The README should recommend a shorter cap, such as `retryStrategy: (n) => Math.min(n * 50, 500)`, for callers who want the primary back sooner.
- **No circuit breaker** (milestone 4, open question 3). A breaker would remove the 50 ms wait while Redis hangs, but that wait was the expected 51 ms in every run, 30 for 30, and a hang is rarer than a crash or a restart, which cost nothing. A breaker adds state, a half-open probe and another setting. Revisit if an outage with a hung Redis shows up in production metrics (`ratelimit_fallback_total{reason="timeout"}`), or if a smaller `timeoutMs` isn't enough.
- **Visibility:** an outage shows in `ratelimit_fallback_total` and in the Grafana dashboard's fallback panel, and the caller can log it through `onFallback`.
