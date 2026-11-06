# 0010. Fail open with a local fallback when Redis is down

- **Status:** Proposed
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

To gather in milestone 4: a chaos test that kills Redis under k6 load. Record the error rate, the latency, the overshoot against the limit, and the time to recover once Redis returns.

## Consequences

During an outage, limits are approximate. They're per instance and drift if the instance count changes. The instance count has to be configured or discovered.
