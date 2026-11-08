# 0021. The benchmarks give each request its own timing tolerance

- **Status:** Accepted
- **Date:** 2026-11-07
- **Milestone:** 5

## Context

The analysis times each request by `t`, when the app received it, but Redis decides by its own `TIME`, a little later. [0017](0017-how-the-benchmarks-measure.md) gave every request a fixed 2 ms of benefit of the doubt for that gap, measured on this Mac with the stack on all 18 CPUs, where the limiter's p99 was under 1 ms. On a busier machine the gap varies more. After milestone 4's close-out, CI's `edges-check.sh` failed once and then passed on every rerun. Its failure only went to the job log, which isn't readable without admin rights, so the check now reports failures as annotations and prints how full the windows on each side of every burst edge got. Locally, with the stack pinned to 2 CPUs, the check failed 1 run in 5. Every time the sliding window log was the failure: a peak of 101 against a limit of 100. The fixed window's 1.8× check, the first suspect, never failed: every window before an edge was full, and the one after got its 100 within 233 to 256 ms.

The log was correct, and the measurement was wrong. When a request takes a slot that an older one just freed, Redis's two times are a full window apart. The request that took the slot may have waited longer in the limiter than the one that freed it. If it waited 3 ms longer, the two arrival times are 3 ms short of a window, and a fixed 2 ms reads that as 101.

## Decision

Each request gets its own tolerance, `slackOf` in `bench/analysis.ts`. Its arrival stamp `t` is taken just before the limiter runs, and the decision happens within the limiter's own time, which `Server-Timing` reports as `limiterMs`. So the decision's time by Redis's clock lies in `[t, t + floor(limiterMs) + 1]`, the 1 for whole-millisecond truncation. The tolerance is that bound, and never less than 0017's 2 ms. Records without `limiterMs` keep 2 ms.

Every window measure gives each request that much benefit of the doubt:

- **Peak per window:** requests count as sharing a window only if they certainly did. Each arrived at or after the span's start and was decided before its end, even at the latest its tolerance allows.
- **False denials:** an allowed request still counts in a denial's trailing window if, decided at its latest, it was less than a window before the denial arrived.
- **The chart's trailing counts** and **the chaos test's peak around a change** use the same rule.

With every tolerance at 2 ms, each measure gives exactly what it did under 0017.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep 2 ms and accept the rare CI failure | A check that fails for no reason gets ignored, and then it can't catch a real overshoot. |
| Raise the fixed tolerance to 5 ms | Arbitrary. It's 2.5 times too generous for most requests, and a slower runner, or one slow request, needs more. |
| Allow `limit + 1` in the CI check only | It would hide a real off-by-one in the log, which is the bug the check exists to catch. |
| Have the scripts return Redis's own time | It changes every script's reply, which the library ships, for the benefit of the benchmarks alone. |
| Use the midpoint of the interval | Not a bound, so it could still show an overshoot that didn't happen, or hide one that did. |

## Evidence

**Before the change, on 2 CPUs.** `bench/edges-check.sh` ran 5 times with the stack pinned to 4 CPUs and 5 times pinned to 2 (`cpus-2.yml` here, through `COMPOSE_FILE`). All 4-CPU runs passed. One 2-CPU run failed: the log's peak was 101. In 10 more 2-CPU rounds, each a fixed-window run then a log run as the check runs them, the shortest span holding 101 of one client's allowed requests was 9,999 or 10,000 ms. Under 9,998 counts as an overshoot. The limiter's p99 was 3.1 to 3.9 ms, with a maximum of 9.6 to 17.0 ms. So the margin was 1 to 2 ms, against delays that regularly vary by more.

**After the change, on 2 CPUs.** 20 more rounds, each log run analysed both ways by `peaks.ts`:

| Measure | Rounds at 101 (over the limit) | Rounds at 100 |
| --- | --- | --- |
| Fixed 2 ms (0017) | 1 | 19 |
| Each request's own tolerance (this record) | 0 | 20 |

The one at 101 is the failure itself. In round 1, client `edge-9` had 101 allowed requests whose arrivals spanned 9,997 ms, 3 ms short of the 10 s window. The limiter spent 0.7 ms on the first and 8.2 ms on the last, so Redis may have decided the last up to 9 ms after it arrived: a full window after the first, as the log requires. Across the 20 rounds the limiter's p99 was 3.1 to 4.8 ms, and its maximum 9.0 to 22.2 ms.

**Unconstrained, after the change.** `bench/edges-check.sh` passed 10 times in a row on all 18 CPUs. The fixed window's peak was 200 every time, and the log's 100.

**No published number changes.** Every committed results directory with a summary was copied and re-analysed with the new method: 0005's four steady runs, 0008's steady, edges and ramp, 0009's two steady runs, and 0010's chaos runs. Every `summary.md`, `spread.md` and `chart.json` came out byte for byte the same. On the 18-CPU runs almost every request's tolerance is the 2 ms floor, and the few slower ones weren't near a window edge.

**Tests.** `test/bench/analysis.test.ts` covers a request the limiter took long over, at both edges of its tolerance, for the peak, false denials and the chart. Breaking the code five ways each failed a test: ignoring `limiterMs`, dropping the tolerance from peak spans, checking only the last request near a span's end, giving false denials a fixed 2 ms, and dropping the tolerance from the chart.

Setup: Apple M5 Pro, Docker 29.4.1 (18 CPUs, 8 GiB), Node 22.23.4 in the app image, Redis 7.4.12, nginx 1.31.8, k6 2.3.0, at commit `7b07d11` plus T0's changes. Commands: `COMPOSE_FILE=docker-compose.yml:docs/decisions/data/0021-edges-2cpu-2026-11-07/cpus-2.yml npm run bench -- --scenario edges --algorithm <fixed-window, then sliding-window-log> --quick`, then `peaks.ts` on each log run. The before rounds' near misses came from `near-misses.mjs`, and the first logged check printed an earlier version of the edge line. Raw data: [data/0021-edges-2cpu-2026-11-07](data/0021-edges-2cpu-2026-11-07/), with every log run's requests.

## Consequences

- A slow request no longer makes a correct limiter look wrong, so the CI edges check can be trusted on a noisy runner.
- The measures are exactly as strict as the records allow and no stricter. When the limiter is slow, a real overshoot by one request could go unnoticed if it landed within that request's tolerance. That's the honest limit of measuring from outside Redis.
- The tolerance needs `limiterMs`, from `Server-Timing`. Records without it, such as with `ALGORITHM=none` or from before milestone 3, keep the 2 ms floor.
