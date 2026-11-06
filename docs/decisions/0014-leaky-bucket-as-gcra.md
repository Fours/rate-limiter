# 0014. The leaky bucket is a burst-free GCRA

- **Status:** Proposed
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

The project plan lists the leaky bucket as the algorithm that "smooths output to a steady rate". A rate limiter doesn't queue requests, so the leaky bucket can only be used as a meter. As a meter with capacity `limit`, it's the token bucket's maths in reverse: the same requests are allowed and denied. Offering both would give milestone 3 two names for one result.

## Decision

The leaky bucket is the Generic Cell Rate Algorithm (GCRA, "virtual scheduling") with no burst. It stores one timestamp per key, the theoretical arrival time (TAT), and admits a request only if it arrives no earlier than that time. Each admitted request moves the TAT on by `windowMs / limit`. So a rule allows one request per `windowMs / limit`, evenly spaced, and never a burst.

- `remaining` is 1 when the next slot is open, otherwise 0.
- When allowed, `resetMs` is the time until the bucket has fully drained, which is the TAT minus now. When denied, it's the time until the next slot.
- The key's TTL is the time until it has drained.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A leaky bucket meter with capacity `limit` | Gives the same decisions as the token bucket |
| GCRA with a burst tolerance | Becomes a token bucket with a different state layout. A burst setting belongs on rules, which milestone 1 left as an open question. |
| A real queue that delays requests | Middleware would hold connections open, which doesn't fit a limiter that answers at once |

## Evidence

To gather in milestone 2, T7: the behaviour suite with a burst of 1, plus tests of even spacing and of `remaining` being 0 or 1. Milestone 3 benchmarks should show it differs from the token bucket under bursty traffic.

## Consequences

`limit: 10, windowMs: 60_000` means one request every 6 s, not 10 at once. The README has to say so plainly, or users will think it's broken. If a separate burst size is ever added to rules, this algorithm is where it would apply first.
