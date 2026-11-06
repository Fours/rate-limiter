# 0008. Sliding window log vs counter: accuracy vs cost

- **Status:** Proposed
- **Date:** 2026-11-06
- **Milestone:** 3

## Context

The sliding window log is exact but stores one sorted-set entry per request. The sliding window counter stores two counters but only approximates the limit.

## Decision

To be decided from benchmarks. The expectation is that the counter is the better default and the log is for cases that need exact limits.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Fixed window | Lets up to 2x the limit through at a window boundary. It stays in the benchmarks as the baseline. |

## Evidence

To gather in milestone 3, for each algorithm:

- Redis memory per key at limits of 10, 100 and 1000 per minute
- Added latency (p50 and p99)
- Throughput
- Overshoot: requests allowed above the limit under bursty traffic at window edges

Raw k6 output goes in `data/`.

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

The write-up's main chart probably comes from this record.
