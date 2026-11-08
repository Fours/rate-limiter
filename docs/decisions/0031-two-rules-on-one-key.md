# 0031. A rule change keeps a client's progress, even when two rules share a key

- **Status:** Accepted. Supersedes, in part, [0022](0022-burst.md)'s whole tokens and milestone 2's counter rule for a changed `windowMs`.
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

When a rule's limit, window or burst changes under a stored key, each algorithm converts the old state. Milestones 1 and 2 designed that for a one-off change, such as a config reload. But during a rolling deploy or a canary, old and new instances run at once behind one load balancer, and a client's checks alternate between the two rules. Every check is then a change.

The 1.0 correctness review found that two conversions lock a client out when that happens:

- **The token bucket carried over whole tokens only** ([0022](0022-burst.md), milestone 1). Every check threw away the fraction of a token refilled since the last one. With rules of 2 and 3 a minute, a client that used up its bucket and then sent one request every 10 s got 0 of 60 in 10 minutes, where about 20 refilled.
- **The sliding window counter put all the old counts in the current window** when `windowMs` changed (milestone 2), aligned to the new window's own epoch boundaries. With windows of 60 s and 61 s, the boundaries are so close that the counts went back into the current window on every check and never aged out. A client sending 2 a minute against a limit of 3 got 3 of 40, then nothing.

Both were meant never to allow more than before, and they don't. But they deny for good a client that's under both limits.

## Decision

- **The token bucket carries the fraction of a token too.** Units convert from the old window's scale to the new one's exactly, rounded down to a unit, and are still capped at the new burst. If the two windows multiplied pass 2^53, the conversion wouldn't be exact, so the fraction is dropped, as before. The Lua script and the in-memory bucket do the same.
- **The sliding window counter keeps the stored windows going.** Each check's window starts a whole number of its own `windowMs` after the stored window's start. Without a change that's the epoch alignment, as before. After a change, the windows go on from where the old ones were, at the new length, so the counts keep their age and roll over normally. A new key still starts on an epoch boundary.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep both conversions, and document that a rule change shouldn't be rolled out gradually | Rolling deploys are the normal way to change config. The failure is a silent lockout of well-behaved clients. |
| Counter: split the old counts between the new windows in proportion to their overlap | Modelled in Python first: rounding still kept the counts in the current window (13 of 40), and over random mixed traffic one window allowed 4.2 times the limit |
| Counter: keep the old window length until the old state ages out | An active client might never age out, so a change from a minute to an hour would never take effect for it |
| Store the rule's version, and convert only when it moves forward | Instances don't share a version number, and the limiter can't tell which rule is newer |

## Evidence

- **Token bucket:** `test/algorithms/token-bucket.test.ts` and `test/integration/algorithms/token-bucket.test.ts` run the review's case: two rules, 2 and 3 a minute, alternating. 20 to 30 of 60 are allowed, against 0 before. Other tests cover the exact fraction across different windows and the cap at the new limit. The parity test between the in-memory and Redis buckets still passes.
- **Counter:** `test/integration/algorithms/sliding-window-counter.test.ts` runs the review's case, 60 s and 61 s windows alternating. At least 28 of 40 are allowed, against 3 before, and never two denials in a row. Some are denied because the estimate sits just over the limit at some checks, 2 × 31/61 + 2 against 3. A Python model over 120 start times allows 39 or 40 of 40 at all but one, the aligned start the test uses. Another test checks that, after a change, the window rolls over a whole new window after the stored start.
- **Safety, from the Python model:** over 4,000 random runs with checks alternating between two windows, the most allowed in any window of the shorter rule was 1.83 times its limit. With one rule it was 1.8. So keeping the windows going doesn't loosen the estimate.
- **Break checks:** dropping the fraction fails 4 tests against Redis and 2 in memory. Going back to the new window's epoch alignment fails 2.

## Consequences

- During a rolling deploy, clients are limited by a mix of the two rules, as you'd expect, and aren't locked out.
- After any `windowMs` change, a counter key's windows are no longer on epoch boundaries, until the key expires. Nothing depends on that: the fixed window, whose 2× boundary burst the benchmarks show, still aligns to the epoch.
- The fixed window and the sliding window log already kept their state's age through a change. The leaky bucket keeps its schedule (0022). Neither needed a change.
