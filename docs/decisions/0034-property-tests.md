# 0034. Property tests for every algorithm, with fast-check

- **Status:** Accepted
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

The algorithm tests check chosen examples. The behaviour suite checks the shared rules at a few points, and the comparisons with the reference models follow one fixed sequence of steps. [Mutation testing](0033-mutation-testing.md) showed what that misses: inputs nobody chose, such as a leaky-bucket remainder of exactly 1, or the counter's wait that ends 1 ms before the window does. Two of those were found again by seeded random histories written by hand, which can't shrink a failure to something readable and were only written for two algorithms.

## Decision

- **[fast-check](https://fast-check.dev/) generates histories,** as a dev dependency only. A history is two rules on one key (0031), mostly short windows and small limits, sometimes a window of a day or more than one request per ms, and up to two clients. It's a list of checks, each with a step of the clock that is sometimes backwards. When a property fails, fast-check shrinks the history to the smallest one that still fails and prints its seed.
- **Seven properties hold for every algorithm,** in `test/contract/algorithm-properties.ts`. Each algorithm gives its own `burst`, which the behaviour suite also checks exactly, and `maxInSpan`, an upper bound worked out from how it counts:
  - Every decision is well formed: whole numbers, a wait of at least 1 ms when denied, and `remaining` below the burst when allowed or 0 when denied.
  - Under one rule, no span between two allowed requests holds more than `maxInSpan`. For the token bucket that's the burst plus what refills, for the log the limit per window, for the leaky bucket the slots in the span plus the early ones, and for the two window algorithms the limit per aligned window.
  - A clock that steps back gives the same decisions as one held at the latest time seen.
  - Denied requests are free: without them, the allowed ones get the same answers.
  - Clients are kept apart: each gets the answers it would get alone.
  - After any history, a denial waits exactly `resetMs`.
  - After any history, an allowed request restores a full burst in exactly `resetMs`.
- **Each script is compared with a reference on every check of any history.** The token bucket script is compared with the in-memory bucket. The other four are compared with their reference models, now in `test/helpers/models.ts`.
- **The Redis runs use `withoutExpiry`.** Its `close` deletes the keys a run made, since nothing expires them.
- **Run counts are set for CI:**
  - In memory: 300 histories of up to 100 checks per property, in about 0.3 s.
  - On Redis: 25 of up to 60 per property, and 100 of up to 120 per comparison, in about 15 s.
  - `FC_RUNS` multiplies every count, for a longer search, and `FC_SEED` replays a failure.
  - Mutation runs use a fixed seed, so two runs try the same histories.
- **The fixed sequences and the two seeded random tests stay.** They pin the cases mutation testing found, whatever seed CI draws.

## Alternatives considered

| Option | Why not |
| --- | --- |
| More seeded random loops written by hand | No shrinking. A failure is check 73 of run 4 out of 120 random steps. |
| A fixed seed in CI | Every run would try the same histories, so CI would never search further. A failure in CI prints the seed that replays it. |
| Properties only, dropping the example tests | Examples show the reader what a rule means, and pin known edge cases on every run. |
| `@fast-check/vitest` | A thin wrapper around `fc.assert`, which works in Vitest as it is |

## Evidence

Run on an Apple M5 Pro with Node 25.8.2, Redis 7.4.12, fast-check 4.10.2 and Vitest 4.1.12.

**No bugs found.** Every property passed:

- at the CI counts;
- in a soak of 2,000 in-memory histories of up to 300 checks, and 60 and 200 Redis histories of up to 200 and 300 (`FC_RUNS` didn't exist yet: the counts were edited by hand);
- at `FC_RUNS=5 npm run test:integration` and `FC_RUNS=20 npm test`.

The correctness review and mutation testing had already been through this code.

**The properties catch real bugs.** Each change below was made by hand, and the property tests were run on it, then the code was restored:

| Change | Caught by |
| --- | --- |
| In-memory token bucket: no high-water mark, so time that steps back refills twice | Clock stepping back |
| In-memory token bucket: `resetMs` rounded down | Well formed, both `resetMs` properties |
| In-memory token bucket: allowed 1 unit short of a token | Well formed, span, both `resetMs` properties |
| Fixed window: no high-water mark | Comparison, clock stepping back |
| Fixed window: denied requests counted | Comparison only: under one rule the count resets with the window, so it shows only after a limit increase |
| Log: entries named from the live count, the bug fixed in the correctness review | Comparison |
| Counter: counts never age out | Comparison, denied requests free, full restore |
| Counter: the next window's wait 1 ms late, or the in-window wait rounded up | Comparison, exact denial wait (and well formed, for the second) |
| Leaky bucket: allowed 1 unit early | Comparison, span, both `resetMs` properties |
| Leaky bucket: the remainder dropped on a rule change | Comparison |
| Token bucket script: a full bucket keeping the old burst, or the fraction dropped on a rule change | Comparison |

Two changes passed every property, and neither changes behaviour:

- Removing the in-memory bucket's cap on carried units: `refill` caps them in the same check.
- The counter's `t < W - e` as `<=`, already an equivalent mutant in 0033.

**Two things went wrong on the way:**

- fast-check's default `size` keeps arrays to about 10 items whatever `maxLength` says. The first soak's histories were never longer than 12 checks. The arrays now use `size: 'max'`.
- The counter's model found its denied wait by stepping 1 ms at a time. With a window of a day, one comparison took 150 s under coverage. It now bisects instead, which gives the same answer because a request that fits keeps fitting as the previous window's share shrinks. The counter's tests and two hand-made wrong waits confirm it still catches what it should.

## Consequences

- A new algorithm gets the properties by adding its traits and calling `describeAlgorithmProperties`, and a script also calls `describeModelComparison`. Its `maxInSpan` has to be worked out, which is a good test of whether its limit is understood.
- A failure in CI can come from a commit that didn't cause it, since each run tries new histories. It's still a real bug, with the seed to replay it: `FC_SEED=<seed> npm run test:integration`.
- The integration suite takes about 15 s longer.
- Mutation runs now run the property tests too, so they take longer.
