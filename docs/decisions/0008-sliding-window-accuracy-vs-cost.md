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

## Consequences

The write-up's main chart probably comes from this record.
