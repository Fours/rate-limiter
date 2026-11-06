# 0017. How the benchmarks measure

- **Status:** Proposed
- **Date:** 2026-11-06
- **Milestone:** 3

## Context

Milestone 3 compares the five algorithms on added latency, throughput, Redis memory and accuracy, and those numbers settle [0008](0008-sliding-window-accuracy-vs-cost.md) and [0009](0009-latency-budget-prefetch.md). They all come from one laptop running Docker, where the load generator, the load balancer, three app instances and Redis share the same CPUs. End-to-end latency on that setup is mostly noise from everything else on the machine. The method has to separate the limiter's own cost from that noise, and be honest about what a laptop can show.

## Decision

- **The limiter's own cost is measured inside the app.** The benchmark app wraps the limiter and reports `Server-Timing: rl;dur=<ms>`: the time from entering it to its `next()`, or to it starting to write a 429. The header is set in `res.writeHead`, because on a 429 the limiter has already sent the response by the time it returns.
- **End-to-end latency is measured too**, by k6, against a baseline with no limiter (`ALGORITHM=none`). That shows what a client would see, network and load balancer included.
- **The stack is the one the project plan draws:** nginx doing round robin with no sticky sessions, in front of three identical instances sharing one Redis 7 with persistence off. Round robin is the worst case for per-instance limits and the normal case for shared ones.
- **k6 runs from a pinned Docker image on the same machine**, so anyone can rerun it with no install. Every image is pinned to an exact version, and every results directory records the machine, versions, git commit and exact command.
- **Each configuration runs three times**, and summaries report the median. Raw output keeps all three.
- **Results are compared between algorithms, never presented as absolute numbers.** A laptop isn't a production cluster.
- **CI never compares numbers.** It builds the image and smoke-tests the stack, because shared runners are too noisy for timings to mean anything.

How the numbers are computed, fixed in T2 before any data existed (`bench/analysis.ts`):

- **Records.** Every scenario writes one line per request, `{ client, t, status, e2eMs, limiterMs }`, whatever produced it (k6 or app logs). `t` is the send time in ms.
- **Peak per window.** For each client, the most allowed requests in any span `[s, s + windowMs)`, and the summary reports the busiest client. The span is half-open, matching the sliding window log's own window `(now − windowMs, now]`, so two requests exactly `windowMs` apart never share one. Overshoot is the peak minus `limit`.
- **False denials.** A 429 when fewer than `limit` requests were allowed for that client in the trailing window `(t − windowMs, t]`: a denial an exact sliding window would have allowed. It's reported as a share of all requests. The token bucket and the leaky bucket score high on it by design, since they refill gradually or allow no burst, so it measures distance from the exact ideal, not bugs.
- **Percentiles: nearest rank**, the `ceil(p/100 × n)`-th smallest sample. A p99 is then a latency some request actually saw, with no interpolation.
- **Throughput.** The busiest whole second, by send time, whose p99 end-to-end time was under 50 ms and whose responses were all 200 or 429. A 429 is the limiter working, not an error.
- **Medians.** Each metric is the median of its runs, taken separately, so each cell is a real middle value. With an even count, it's the mean of the middle two.
- **Chart data.** For the run with the median peak, the busiest client's allowed requests over time, each with the count in its trailing window.

## Alternatives considered

| Option | Why not |
| --- | --- |
| End-to-end latency only | On one machine, the load balancer and k6 add more variance than the limiter costs, so the differences between algorithms would be lost in noise |
| Timing `algorithm.check` directly, in a Node script with no HTTP | Leaves out the middleware's own work: matching rules, building the key and setting headers. It's also not how an app would run the limiter. |
| A Prometheus histogram for the limiter's time | Milestone 4 brings hooks and Prometheus. A header needs neither, so this works now and doesn't change the library. |
| Benchmarks in CI | Shared runners vary from run to run, so a regression check would flake. Numbers would also change with GitHub's hardware rather than with the code. |
| k6 installed on the host | Its version would vary between machines, and people would have to install it |

## Evidence

From milestone 3, T0:

- A probe on Express 5.3.0 showed that `res.json`, `res.send` and `res.end` all send headers through `res.writeHead`, so the header can be set there for every response.
- `test/integration/bench/app.test.ts` checks that `Server-Timing` is present and well formed on allowed responses and on 429s, and absent with `none` and on `/healthz`. Making the header depend on `next()` alone (so no 429 would get it) fails that test.

From T2:

- `test/bench/analysis.test.ts` pins each definition above with hand-made records, and builds a summary and chart from a fixture directory whose every value was worked out by hand. Breaking each definition fails a test: a closed span, a trailing window that keeps `t − windowMs`, a percentile one rank high, using the first run instead of the median, an SLO that admits exactly 50 ms, and a throughput that ignores errors.

Still to gather: in T5, the numbers this method produces, and whether three runs are enough to keep the medians stable. If the spread between runs is close to the differences between algorithms, that changes this record.

## Consequences

The limiter's cost and the end-to-end cost are reported separately, so readers can see both. `Server-Timing` only exists in the benchmark app, so the library itself doesn't change. The numbers describe one machine. Rerunning on other hardware should keep the order of the algorithms, but not the absolute values.
