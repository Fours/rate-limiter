# 0022. An optional `burst` on rules, for the token and leaky buckets only

- **Status:** Accepted
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

Until now a rule's `limit` set two things at once for the two buckets: the steady rate, and how many requests could arrive together. The token bucket allowed `limit` at once, and the leaky bucket ([0014](0014-leaky-bucket-as-gcra.md)) allowed one. Milestone 3's benchmarks showed what each extreme costs. A burst of the whole limit let the token bucket through at 1.54× the limit at window edges. No burst at all made the leaky bucket deny 23% of steady traffic from clients well under their limit ([0008](0008-sliding-window-accuracy-vs-cost.md)). Real APIs usually want something in between, such as 100 a minute with at most 10 at once. It changes the rules API, so it had to land before the first npm release.

## Decision

Rules take an optional `burst`, a positive integer.

- **Token bucket:** `burst` is the bucket's size, in tokens. It still refills at `limit` per `windowMs`. The default is `limit`, so a rule without a burst behaves exactly as before. The bucket keeps integer units of `burst * windowMs`, so validation bounds that product by `2^53`, like `limit * windowMs`.
- **Leaky bucket:** `burst` is the GCRA's tolerance. A client can take a slot up to `(burst − 1)` intervals early, so `burst` requests can arrive at once and then one per interval follows. The default is 1: no tolerance, as 0014 decided. The tolerance is kept in the same exact units as the remainder, 1/limit ms, and the divisions it needs are exact even near `2^53`.
- **Window algorithms take none.** The fixed window and both sliding windows have no burst to set: a window's whole limit can already arrive at once. A rule with a burst checked by one of them throws at startup, rather than having its burst silently ignored. Algorithms say they take a burst with an optional `supportsBurst: true` on `Algorithm`. The token and leaky buckets set it, in memory and in Redis, and a caller's own algorithm can set it too.
- **`burst` can be larger than `limit`.** "10 a second, with bursts of 50" is a real pattern.
- **Headers:** `RateLimit-Limit` stays `limit`, the steady rate, as the header drafts define it: a quota per window. `RateLimit-Remaining` is what can be sent now, at most `burst`. With a burst above the limit, `Remaining` can be higher than `Limit`.
- **The fallback** shares a burst between instances like the limit: `max(1, ceil(burst / instances))` each ([0010](0010-fail-open-with-local-fallback.md)).
- **In the scripts,** the burst is `ARGV[4]`, after the test-only time override. Empty means the rule's default. The window scripts don't read it.

When a burst changes under a stored key, each bucket does what it naturally does, and neither ever allows more than the new burst:

- **The token bucket keeps whole tokens,** capped at the new burst, as it already did for a changed limit. A raised burst doesn't fill the bucket; it refills to the new size at the steady rate.
- **The leaky bucket keeps its schedule,** the theoretical arrival time. That's the client's debt, how far ahead of now its next slot is, and the burst only changes how much debt is allowed. So a raised burst gives the extra room at once, and a cut takes it away at once.

The token bucket stores its burst only when it differs from the limit, and deletes the field when the two match again. A rule without a burst then stores exactly what it did before, so state written before this change reads as before, and 0008's memory figures still hold. The leaky bucket needs no new field, since its schedule doesn't depend on the burst.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Ignore `burst` for the window algorithms | A burst that does nothing looks like a bug in the limiter. Failing at startup says why. |
| A fixed list of algorithm names that take a burst | A caller's own algorithm couldn't join. `supportsBurst` is additive and doesn't change `check`. |
| `RateLimit-Limit` reports the burst | The header drafts define it as a quota per window, and the burst isn't one. |
| Cap `burst` at `limit` | Rules out a common pattern, a low steady rate with occasional large bursts. |
| The leaky bucket keeps "tokens" across a burst change, like the token bucket | It would need a second stored value and a conversion on every change. Keeping the schedule is what a GCRA is, and it never exceeds the new burst either. |
| Always store the token bucket's burst | Changes the stored state, and the measured memory, of every rule, including ones with no burst. |

## Evidence

- `test/algorithms/token-bucket.test.ts`: the in-memory bucket allows `burst` at once and then `limit` per `windowMs`, refills to the burst rather than the limit, takes a burst above the limit, caps the tokens it carries over when the burst is cut, gives no free refill when it's raised, and behaves exactly as before when the burst equals the limit.
- `test/integration/algorithms/token-bucket.test.ts`: the Redis token bucket makes exactly the same decisions as the in-memory one over `burstSteps()`. That's 85 checks with bursts below and above the limit, an interval that isn't a whole number of ms, the burst raised, cut and removed under a stored key, limit and window changes, and the clock stepping back. It also reads a bucket stored in the old format, and stores the burst field only when it's needed.
- `test/integration/algorithms/leaky-bucket.test.ts`: the script makes exactly the same decisions as a BigInt reference model, extended with the tolerance, over the same steps. It allows 3 at once and then one every 15 s for 4 a minute with a burst of 3, keeps slots exact for 7 a minute with a burst of 2, and holds a client to the new burst when it's cut or raised under a stored key.
- `test/rules.test.ts`, `test/rules-file.test.ts`, `test/middleware.test.ts` and `test/middleware.fallback.test.ts`: bad values, `burst * windowMs` past `2^53`, a burst on each window algorithm and on a caller's algorithm without `supportsBurst`, the headers through supertest, and the fallback's share, each tested.
- Breaking the code on purpose made a test fail each time. The breaks were:
  - the in-memory bucket with no cap on its tokens
  - its capacity ignoring the burst
  - the token script with no cap
  - each script ignoring `ARGV[4]`
  - the token script not deleting a stale burst field
  - the leaky script's denial `resetMs` and its `remaining` ignoring the tolerance
  - no startup check
  - the fallback not sharing the burst

  The cap on carried-over tokens is enforced twice, once when tokens carry over and again by every refill. Removing only one of the two can't show, so the break removed both.

## Consequences

- A rule can now say "100 a minute, 10 at once", and both buckets measure the steady rate the same way as before.
- The two buckets react differently to a raised burst: the token bucket grows into it, and the leaky bucket gives it at once. The README says so, and both stay within the new burst.
- The token script can call `HDEL`, so the in-browser Redis stand-in in T5 needs 14 commands, not 13.
- Per-rule algorithms (T2) need the burst check per rule, against the rule's own algorithm.
