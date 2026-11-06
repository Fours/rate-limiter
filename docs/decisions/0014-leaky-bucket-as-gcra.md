# 0014. The leaky bucket is a burst-free GCRA

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

The project plan lists the leaky bucket as the algorithm that "smooths output to a steady rate". A rate limiter doesn't queue requests, so the leaky bucket can only be used as a meter. As a meter with capacity `limit`, it's the token bucket's maths in reverse: the same requests are allowed and denied. Offering both would give milestone 3 two names for one result.

## Decision

The leaky bucket is the Generic Cell Rate Algorithm (GCRA, "virtual scheduling") with no burst. It stores one timestamp per key, the theoretical arrival time (TAT), and admits a request only if it arrives no earlier than that time. Each admitted request moves the TAT on by `windowMs / limit`. So a rule allows one request per `windowMs / limit`, evenly spaced, and never a burst.

- The TAT is stored as whole ms plus a remainder in 1/`limit` ms. The interval is rarely a whole number of ms (7 per minute is 8571.43 ms), and `now × limit` can pass 2^53, so this keeps every value an exact integer with no drift.
- A request is allowed if its slot starts within the current millisecond. Requiring the slot to have fully arrived would, with a millisecond clock, cap every rule at one request per ms. For any rule of at most one request per ms, the two are the same: one at a time.
- So the burst is `ceil(limit / windowMs)`: 1 for rules of at most one request per ms, and the slots within one millisecond for faster rules.
- `remaining` is how many more slots start within this millisecond: 0, unless the rule is faster than one per ms.
- When allowed, `resetMs` is the time until the bucket has fully drained. When denied, it's the time until the next slot starts.
- The key's TTL is the time until it has drained.
- If the rule changes under a key, the TAT rounds up to a whole ms, so the next slot never comes earlier.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A leaky bucket meter with capacity `limit` | Gives the same decisions as the token bucket |
| GCRA with a burst tolerance | Becomes a token bucket with a different state layout. A burst setting belongs on rules, which milestone 1 left as an open question. |
| A real queue that delays requests | Middleware would hold connections open, which doesn't fit a limiter that answers at once |

## Evidence

- `test/integration/algorithms/leaky-bucket.test.ts` runs the behaviour suite with `burst = ceil(limit / windowMs)` and `maxPerWindow = limit`.
- A reference model that keeps the TAT as one exact fraction matches the script step for step.
- 4 per minute, asked every second for 75 s, is allowed at 0, 15, 30, 45, 60 and 75 s. A new client gets one request, then waits 15 s.
- 7 per minute is allowed at 0, 8 571, 17 142, 25 714, 34 285, 42 857 and 51 428 ms, and again at exactly 60 000: no drift.
- 10 per 4 ms allows three requests in its first millisecond (`remaining` 2, 1, 0) and exactly 10 in 4 ms.
- Before writing the script, the whole-ms-plus-remainder state was checked against exact fractions for 4 000 requests under 7 rules, with no differences.
- Saving up a burst for an idle client, which would make it a token bucket, fails the behaviour suite's idle property.

Milestone 3 benchmarks should show it differs from the token bucket under bursty traffic.

## Consequences

`limit: 10, windowMs: 60_000` means one request every 6 s, not 10 at once. The README has to say so plainly, or users will think it's broken. If a separate burst size is ever added to rules, this algorithm is where it would apply first.
