# 0017. How the benchmarks measure

- **Status:** Accepted
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

- **Records.** Every scenario writes one line per request, `{ client, t, sentAt, status, e2eMs, limiterMs }`. The k6 script logs each request itself. `t` is when the app received the request, by `Date.now()`: the same wall clock Redis `TIME` reads, and in whole ms like Redis. `sentAt` is k6's own send time, kept for comparison. *Changed in T3*, from "the send time": see the evidence below. The ramp is the exception (*changed in T5*): logging every request capped k6 below the stack's knee, so the ramp keeps per-second totals from k6's own JSON output instead, by when each response arrived.
- **Peak per window.** For each client, the most allowed requests in any span `[s, s + windowMs − 2 ms)`, and the summary reports the busiest client. The span is half-open, matching the sliding window log's own window `(now − windowMs, now]`. Overshoot is the peak minus `limit`.
- **2 ms of resolution** (`RESOLUTION_MS`, *added in T3*). Redis `TIME` is truncated to whole ms, and so is `t`. Two requests the log correctly allows one window apart by Redis's clock can therefore look up to about 2 ms closer by `t`. Window comparisons give that much benefit of the doubt: spans for the peak are 2 ms shorter, and trailing windows for false denials 2 ms longer. That's 0.02% of a 10 s window, so it can't hide a real overshoot such as the fixed window's 2×.
- **False denials.** A 429 when fewer than `limit` requests were allowed for that client in the trailing window `(t − windowMs − 2 ms, t]`: a denial an exact sliding window would have allowed. It's reported as a share of all requests. The token bucket and the leaky bucket score high on it by design, since they refill gradually or allow no burst, so it measures distance from the exact ideal, not bugs.
- **Percentiles: nearest rank**, the `ceil(p/100 × n)`-th smallest sample. A p99 is then a latency some request actually saw, with no interpolation.
- **Throughput.** The busiest whole second whose p99 end-to-end time was under 50 ms, whose responses were all 200 or 429, and in which k6 dropped no iterations. A 429 is the limiter working, not an error. A dropped iteration is a request k6 should have sent but couldn't, short of VUs or CPU: in that second the load generator was the limit, so it can't show what the stack sustained. *The drop rule was added in T5*, as were seconds by arrival time for the ramp.
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

From T3:

- **k6's JSON output can't give send times.** A probe on k6 2.3.0 against a server that waits 500 ms before answering showed the JSON timestamp is when the response arrived, not when the request was sent. So the k6 scripts log each request themselves.
- **Send time was the wrong clock.** The first quick runs timed windows by k6's send time and by the app's `performance.timeOrigin + performance.now()`. The sliding window log then showed 101 against a limit of 100 in 10 spans over 4 runs, each 9,999.5 to 9,999.99 ms long, and 3 false denials 5 to 14 ms past a window. Neither is possible for the log. A probe inside an app container showed the monotonic clock wandering 0.3 to 1.3 ms from the wall clock as Docker's VM corrected its time, differently in each instance. Redis reads the wall clock.
- **With `Date.now()` in the app**, 4 more runs of the log gave a peak of exactly 100 with 0 false denials at a 2 ms resolution. At 0 ms, two runs still showed 101 and three showed false denials. At 1 ms, one false denial remained. That's what sets 2 ms.
- **The trickle had to be jittered.** At a fixed 200 ms, which divides the 10 s window, trickle requests recurred exactly one window apart, on the very millisecond a slot freed up. It's now 150 to 250 ms at random, and bursts fall on every other boundary, so a burst ages out mid-trickle rather than during the next burst.
- These changes came after seeing data, which T2 meant to avoid. They're kept because each one is about the measurement's resolution, not about which algorithm looks better, and each applies to every algorithm equally.

From T5:

- **The first full ramp measured k6, not the stack.** Every run of every algorithm topped out between 18,700 and 21,300 req/s, with no second over the SLO, and k6 warned it had run out of VUs and dropped about 90,000 iterations a run. Meanwhile each container sat near half a core. Two probes on a quick ramp found the cause: with the per-request `console.log` turned off, k6 reached the full 30,000 req/s with no drops on 500 VUs, against 23,000 drops on 3,000 VUs with it on. k6 serialises console output. That data is not in `docs/decisions/data/`, since it measures the logger.
- **k6's JSON output kept up.** A quick ramp to 60,000 req/s had no drops below about 45,000. Pre-allocating 2,000 VUs instead of 500 stopped drops that came from starting VUs mid-ramp. With `ALGORITHM=sliding-window-log`, p99 then crossed 50 ms between 30,000 and 35,000 req/s, with nginx's one worker at 104% of a core, the apps at about 123% and Redis at 79%, while k6 used 8 of the machine's 18 cores. That's a real knee, in the stack. So the ramp now targets 60,000 req/s with `LOG=0` and `--out json`, and `bench/records.ts` (`K6Seconds`) turns the JSON into per-second totals with drops counted.
- Steady (500 req/s) and edges (about 1,000 req/s) dropped no iterations in any run, so their console-logged records stand.
- Like T3's changes, this one came after seeing data. It's kept because it removes a ceiling every algorithm hit equally, and the throughput rule only gets stricter.

**Are three runs enough?** Each results directory has a `spread.md` with every metric's lowest and highest value across the three runs. The numbers themselves are in [0008](0008-sliding-window-accuracy-vs-cost.md).

- **Accuracy is stable.** The peak per window was the same in all three runs for the log (100) and the fixed window (200), and within one request for the token and leaky buckets. False denials varied by at most 2 points. The counter's peak ranged from 104 to 143: its estimate depends on how the previous window's requests fell, so one run in three caught a worse alignment. The median hides that, so 0008 reports the range too.
- **Latency is stable but can't rank the algorithms.** The limiter's p99 at 500 req/s ranged 0.66 to 0.76 ms across all runs of all algorithms, and one algorithm's three runs spread as wide as the gaps between algorithms. The medians are steady to about 0.05 ms. The honest reading is that the algorithms cost the same, not that one is faster, and 0008 says so. More runs would narrow the medians but not change that reading, since every algorithm makes one Redis round trip.
- **Throughput separates a limiter from none, not one limiter from another.** The limiters' ranges (38,000 to 42,000 req/s) overlap; none's (42,000 to 48,000) sits above them. Its widest spread, 6,000 req/s, comes from a ragged knee: some runs went over the SLO briefly and then came back under it at a higher rate.

So three runs are enough for what the benchmarks decide. Where the spread is as wide as the differences, the records say the result is a tie rather than ranking algorithms on noise.

One fix to the setup records: the runner's `uncommittedChanges` counted untracked files, including the results of the scenarios it had just run, so the edges and ramp `setup.json` files say `true` on a clean checkout. `hasUncommittedChanges` in `bench/setup.ts` now leaves the results directories out, with a test that breaks if they're counted again or if untracked code stops counting.

## Consequences

The limiter's cost and the end-to-end cost are reported separately, so readers can see both. `Server-Timing` only exists in the benchmark app, so the library itself doesn't change. The numbers describe one machine. Rerunning on other hardware should keep the order of the algorithms, but not the absolute values.
