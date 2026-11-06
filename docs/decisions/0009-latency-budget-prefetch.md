# 0009. Local token pre-fetching to cut Redis round trips

- **Status:** Proposed
- **Date:** 2026-11-06
- **Milestone:** 3, 4

## Context

Checking Redis on every request adds a network round trip. An instance could instead reserve a small batch of tokens and hand them out locally, at the cost of letting traffic overshoot the limit.

## Decision

To be decided from measurements. Try pre-fetching batches of 1 (no pre-fetch), 5 and 20 tokens per instance.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Always check Redis | The baseline, and exact |
| Only local limits with periodic syncing | Overshoot is unbounded between syncs |

## Evidence

To gather: for each batch size, the added latency (p50 and p99), Redis operations per second, and the worst-case overshoot with 3 instances.

## Consequences

If pre-fetching is adopted, it's off by default and its overshoot is documented.
