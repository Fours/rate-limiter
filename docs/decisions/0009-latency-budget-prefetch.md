# 0009. Local token pre-fetching to cut Redis round trips

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 3

## Context

Checking Redis on every request adds a network round trip. An instance could instead reserve a small batch of tokens and hand them out locally, at the cost of letting traffic overshoot the limit.

## Decision

**Milestone 4 doesn't ship pre-fetching.** Every check stays one round trip to Redis.

The round trip it would save is already small, it isn't what limits throughput, and the saving would cost exactness:

- **The round trip is under 1 ms.** The token bucket's own time was 0.11 ms at p50 and 0.85 ms at p99 at 15,000 req/s, and it added under 1 ms at p99 end to end. That's under 2% of the 50 ms budget ([0010](0010-fail-open-with-local-fallback.md)).
- **Redis isn't the bottleneck.** At the knee in [0008](0008-sliding-window-accuracy-vs-cost.md), around 40,000 req/s, the Node apps were at a full core each while Redis used about 61% of one. Fewer Redis calls wouldn't raise throughput on this stack.
- **Batches cost accuracy.** With 3 instances and batches of b, up to 3 × (b − 1) more requests get through in a window than the algorithm's own bound, and up to 2 × (b − 1) can be denied while tokens sit unused on the other instances. At 100 per minute that's 12 more for batches of 5 and 57 for batches of 20.

The measurements were of the baseline only, batch size 1, as the milestone 3 spec chose: with a sub-millisecond round trip, building a prototype to measure batches of 5 and 20 wouldn't change the answer. The overshoot for those sizes is worked out below.

Revisit if Redis gets slow to reach (in another region, say) or becomes the bottleneck. Even then, a better first step is caching denials locally until their `resetMs`. Most round trips under load are for clients already over their limit (78% at 15,000 req/s here), and other instances' traffic can only push a client's next allowed time later, never earlier, so a cached denial lets nothing extra through. Batching is the next step after that.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Always check Redis | **Chosen.** Exact, and its cost is under 1 ms at p99 |
| Pre-fetch batches of 5 or 20 | Saves round trips that aren't the bottleneck, at the cost of up to 3 × (b − 1) extra requests a window and false denials from tokens stranded on other instances |
| Cache denials locally until `resetMs` | Not needed now, for the same reason. It's the first thing to try if the round trip ever matters, since it's nearly exact: the app's clock may differ from Redis's by a few ms. |
| Only local limits with periodic syncing | Overshoot is unbounded between syncs |

## Evidence

### The baseline: one round trip per check (milestone 3, T6)

The token bucket and `none` on the milestone 3 stack (nginx, three instances, one Redis), three runs each at two rates, 60 s per run, 1,000 clients at 100 per minute each. Each cell is the median of three runs; the method is [0017](0017-how-the-benchmarks-measure.md).

| Rate | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms), none → token bucket | End-to-end p99 (ms), none → token bucket | Round trips per request | Round trips per second | Redis commands per request |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 500 req/s | 0.18 | 0.72 | 0.53 → 0.56 | 1.52 → 1.92 | 1.000 | 500 | 6.3 |
| 15,000 req/s | 0.11 | 0.85 | 0.23 → 0.34 | 1.38 → 2.26 | 1.000 | 14,989 | 7.0 |

- **Added latency** is 0.03 to 0.11 ms at p50 and 0.4 to 0.9 ms at p99. Run-to-run spread on the limiter's p99 was 0.71 to 0.73 ms at 500 req/s and 0.81 to 0.86 ms at 15,000.
- **Round trips** come from `INFO commandstats` before and after each run: exactly one `EVALSHA` per request (plus one `EVAL` per instance, loading the script). Commands per request also counts what the script runs inside Redis (`TIME`, `HMGET`, `HSET` and so on), which cost Redis CPU but no round trip.
- **Overshoot** at 15,000 req/s, where each client sends about 900 a minute against a limit of 100: the busiest client got 199 in a minute, the token bucket's own bound of 2 × limit − 1, in every run. 78% of requests were denied.
- At 15,000 req/s k6 dropped 300 to 1,200 of about 900,000 requests a run, almost all in its first second while starting VUs, and one run fell 275 short in one other second. That's about 0.1%. At 500 req/s it dropped none.

Redis here is on the same host as the apps. A Redis across a network adds that network's round trip to every check, which is the case to revisit.

Setup: Apple M5 Pro, Docker 29.4.1 (18 CPUs, 8 GiB), Node 22.23.4, Redis 7.4.12, nginx 1.31.8, k6 2.3.0, at commit `14c013e`. Commands: `npm run bench -- --scenario steady --algorithm none,token-bucket --rate 500 --decision 0009`, then the same with `--rate 15000`. Raw data: [data/0009-steady-500rps-2026-11-07](data/0009-steady-500rps-2026-11-07/), [data/0009-steady-15000rps-2026-11-07](data/0009-steady-15000rps-2026-11-07/). The 15,000 req/s per-request records are 44 MB, so git keeps that directory's summary, spread, Redis calls and k6 summaries, and the records stay on the machine that ran them, like the ramp's in 0008. The 500 req/s directory has everything.

### Batches of 5 and 20, worked out

Not measured: see the Decision. With I instances, each holding a batch of b tokens for a key:

- **Round trips** fall from 1 per request to 1/b at best. That needs each instance to see b requests for the key before its batch runs out or expires. Under round robin, a client has to send I × b requests for every instance to use its whole batch.
- **Extra requests per window.** Tokens leave Redis when they're reserved but get spent later, so a window can see the algorithm's own maximum plus whatever each instance was still holding when the window started: up to I × (b − 1).
- **False denials.** When one instance runs out, up to (I − 1) × (b − 1) tokens can sit unused on the others, so a client is denied while under its limit.

| Batch size | Round trips per request, at best | Extra requests per window (3 instances) | Tokens stranded on other instances | Token bucket's worst window at limit 100 |
| --- | --- | --- | --- | --- |
| 1 (today) | 1 | 0 | 0 | 199 |
| 5 | 0.2 | 12 | 8 | 211 |
| 20 | 0.05 | 57 | 38 | 256 |

## Consequences

Every check stays one atomic Lua script ([0006](0006-atomic-lua-checks.md)), so limits stay exact to each algorithm's own bound. The cost is one sub-millisecond round trip per request, which the 50 ms timeout in milestone 4 covers many times over. Milestone 4 drops pre-fetching from its scope. Redis round trips are now recorded for every benchmark run, so if Redis ever becomes the bottleneck the numbers will show it.
