# 0004. Limit in app middleware, not at the load balancer

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 1

## Context

Rate limiting can run at the edge (the load balancer or API gateway) or inside the app. The rules need API keys, user IDs and tiers, and only the app knows those.

## Decision

The limiter is Express middleware running in every app instance, sharing state through Redis from milestone 2 on.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Load balancer limits (for example nginx `limit_req`) | Per-IP only. It can't see tiers or authenticated users. |
| A managed API gateway | Ties the project to one vendor, and shows less engineering |
| A separate limiter service | One more network hop on every request, and one more thing to deploy |

## Evidence

The milestone 3 benchmarks record the latency the limiter adds per request (`ratelimit_check_seconds`). This is the price of the choice.

## Consequences

Every request costs a Redis round trip, which [0009](0009-latency-budget-prefetch.md) looks at. Traffic that never reaches the app, such as a flood of bad TLS connections, isn't covered and still needs edge protection. Behind a load balancer, `trust proxy` must be set or every client shares the load balancer's IP.
