# 0008. Sliding window log vs counter: accuracy vs cost

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 3

## Context

The sliding window log is exact but stores one sorted-set entry per request. The sliding window counter stores two counters but only approximates the limit.

## Decision

**The sliding window counter is the recommended algorithm for Redis. The sliding window log is for rules that must never exceed their limit, and it suits small limits best.**

The benchmarks decide this on memory and accuracy, because on speed the five algorithms can't be told apart:

- **Speed is a tie.** The limiter's own p99 was 0.69 to 0.75 ms at 500 req/s for every algorithm, and the spread between runs of one algorithm was as wide as the gaps between algorithms. At saturation, every limiter sustained 38,600 to 40,400 req/s, against 47,700 with no limiter, again with overlapping ranges. The limiter's cost is one Redis round trip, whichever script runs.
- **Memory is where they differ.** The counter costs 192 bytes a key at any limit. The log costs one sorted-set entry per allowed request: 3 KB at 100 per minute and 103 KB at 1,000, 536 times the counter.
- **The log is also the one that loads Redis most:** 78% of a core at the peak against about 61% for the others, since every check trims and counts a sorted set.
- **Accuracy:** with bursts at window edges and a limit of 100, the log never allowed more than 100 in any window, as designed. The counter allowed at most 143 across three runs (median 105), against the fixed window's 200 and the token bucket's 155. The counter's cost is a share of false denials when traffic is bursty (13 to 15% in the edges scenario, none at a steady rate), because it assumes last window's requests were spread evenly.

So the counter gives near-exact limits for a flat, small cost and is the right choice for most rules. The log is worth its cost when overshoot is unacceptable, such as login attempts or paid quotas, and it's cheapest when the limit is under 128 per window, where Redis keeps its sorted set compact.

The README already says this ("a good default for Redis"). Nothing in the code changes: Redis users pick a factory, and the in-memory default stays the token bucket. The README's Benchmarks section (T7) links here.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Fixed window | Lets up to 2x the limit through at a window boundary, and it did: 200 against a limit of 100 in every edges run. It's no faster than the counter and saves 16 bytes a key. It stays in the benchmarks as the baseline. |
| Sliding window log as the default | Exact, but its memory grows with the limit and it uses the most Redis CPU, for an accuracy most rules don't need |
| Token bucket for Redis | The best default in memory, where it has no storage cost to speak of. Behind Redis it costs the same as the counter but lets up to 2x − 1 through after a quiet spell (155 at the edges), which is the point of a bucket, not a sliding window. |

## Evidence

To gather in milestone 3, for each algorithm:

- Redis memory per key at limits of 10, 100 and 1000 per minute
- Added latency (p50 and p99)
- Throughput
- Overshoot: requests allowed above the limit under bursty traffic at window edges

Raw k6 output goes in `data/`.

### Latency, throughput and accuracy (milestone 3, T5)

Three runs of each scenario per algorithm, on the stack from [0004](0004-limit-in-app-middleware.md): nginx with one worker, three app instances, one Redis. Each cell is the median of three runs; the method is [0017](0017-how-the-benchmarks-measure.md).

**Steady**: 500 req/s for 60 s from 1,000 clients, 100 per minute each.

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | False denials |
| --- | --- | --- | --- | --- | --- |
| none | – | – | 0.57 | 1.49 | – |
| Token bucket | 0.18 | 0.73 | 0.56 | 1.87 | 0.0% |
| Leaky bucket | 0.18 | 0.72 | 0.54 | 1.82 | 23.1% |
| Fixed window | 0.17 | 0.69 | 0.53 | 1.83 | 0.0% |
| Sliding window log | 0.19 | 0.75 | 0.57 | 1.92 | 0.0% |
| Sliding window counter | 0.18 | 0.73 | 0.56 | 1.84 | 0.0% |

The limiter adds 0.3 to 0.4 ms at p99 end to end. The leaky bucket's false denials are by design: it allows no burst, so a client that sends two requests close together is denied the second even when well under its limit.

**Edges**: 10 clients, each sending its full limit just before and just after every other boundary of a 100 per 10 s window, plus a jittered trickle. This is where algorithms differ.

| Algorithm | Peak in any window (median, range) | Over the limit | False denials | Limiter p99 (ms) |
| --- | --- | --- | --- | --- |
| Token bucket | 154 (154–155) | 1.54× | 0.0% | 1.29 |
| Leaky bucket | 54 (53–54) | never | 70.3% | 1.34 |
| Fixed window | 200 (200–200) | 2.00× | 0.0% | 1.36 |
| Sliding window log | 100 (100–100) | never | 0.0% | 1.40 |
| Sliding window counter | 105 (104–143) | 1.05×, at most 1.43× | 14.6% | 1.32 |

Every peak is within the bound the behaviour suite holds each algorithm to (`maxPerWindow`): the limit for the log and the leaky bucket, 2× − 1 for the token bucket, 2× for the fixed window and the counter.

**Ramp**: the arrival rate rises from 100 to 60,000 req/s over 60 s. Throughput is the busiest second with p99 under 50 ms, no errors, and no requests k6 failed to send.

| Algorithm | Throughput (req/s), median | Range | Redis CPU at the peak |
| --- | --- | --- | --- |
| none | 47,721 | 42,003–48,023 | 1% |
| Token bucket | 39,260 | 38,290–39,461 | 60% |
| Leaky bucket | 38,804 | 38,427–39,058 | 62% |
| Fixed window | 40,432 | 39,565–40,974 | 63% |
| Sliding window log | 39,977 | 38,855–42,152 | 78% |
| Sliding window counter | 38,620 | 37,984–39,800 | 61% |

At the peak, the three Node apps were at 101 to 109% of a core each (Node's main thread full, plus its helper threads) and nginx's one worker at 88 to 96%, so the apps were the limit, not Redis. The knee is ragged: p99 first went over 50 ms anywhere from 28,000 to 42,000 req/s, and some later, busier seconds came back under it. A laptop runs all of this on one machine, so these are for comparing algorithms, not for capacity planning.

Setup: Apple M5 Pro (18 cores, 24 GiB), Docker 29.4.1 with 18 CPUs and 8 GiB, Node 22.23.4 in the app image, Redis 7.4.12, nginx 1.31.8, k6 2.3.0. Commands: `npm run bench` at `274d5f5` for steady and edges, then `npm run bench -- --scenario ramp` at `3b7874e`, after the first ramp turned out to measure k6's console logging (0017). The edges and ramp `setup.json` files say `uncommittedChanges: true`; the only changes were the earlier scenarios' untracked results, which the runner counted until a fix in T5. Each directory holds `summary.md`, `spread.md`, `setup.json` and every run's data. The ramp keeps per-second totals; its raw k6 output, about 170 MB a run, isn't in git.

Raw data: [data/0008-steady-2026-11-06](data/0008-steady-2026-11-06/), [data/0008-edges-2026-11-07](data/0008-edges-2026-11-07/), [data/0008-ramp-2026-11-07](data/0008-ramp-2026-11-07/).

### Memory per key (milestone 3, T4)

Bytes per key from `MEMORY USAGE key SAMPLES 0` after `limit` checks on one new key, with the key's encoding. Every key is 35 bytes long, like `rl:orders:free:key_3f2a9c1e5b7d4e8a`, because the count includes the key's name.

| Algorithm | 10 per minute | 100 | 127 | 128 | 1,000 |
| --- | --- | --- | --- | --- | --- |
| Token bucket | 160 | 160 | 160 | 160 | 160 |
| Leaky bucket | 176 | 176 | 176 | 176 | 176 |
| Fixed window | 176 | 176 | 176 | 176 | 176 |
| Sliding window log | 400 | 3,152 | 4,176 | 15,328 | 102,944 |
| Sliding window counter | 192 | 192 | 192 | 192 | 192 |

- **The counter costs the same at any limit**, 192 bytes: its hash holds two counts and three timestamps.
- **The log grows with the limit**, one sorted-set entry per allowed request. Up to 128 entries Redis keeps it in a compact `listpack`, at about 31 bytes an entry. One more entry (a limit of 128, because the log also stores a tag member) turns it into a `skiplist`, and the same data takes 3.7× the memory. At 1,000 per minute, a key costs 103 KB: **536 times the counter's**.
- So a million active clients at 1,000 per minute would need about 96 GiB for the log and 183 MiB for the counter.

Setup: Redis 7.4.12 (`redis:7-alpine`, the test Redis) with default encoding thresholds (`zset-max-listpack-entries 128`, `hash-max-listpack-entries 512`), Node 25.8.2 on the host, Apple M5 Pro. The numbers depend only on what each script stores and on these thresholds, not on load, so one run each is enough. Command: `npm run bench:memory`. Raw data: [data/0008-memory-2026-11-06](data/0008-memory-2026-11-06/).

## Consequences

The write-up's main chart probably comes from this record: `chart.json` in the edges data holds each algorithm's busiest client over time.

Recommending the counter means accepting some overshoot (up to 1.43× here) and some false denials under bursty traffic. Rules that can't accept either should use the log and budget its memory. Since speed doesn't differ, choosing per rule costs nothing at request time, which bears on the milestone 2 question of an `algorithm` field in rules (answered in the milestone 3 spec).
