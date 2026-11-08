# 0028. Each limiter sharing a Redis gets its own key prefix

- **Status:** Accepted
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

Storage keys are `rl:{rule.id}:{clientId}`. Rule IDs are checked for uniqueness only within one `rateLimit()`, and [0023](0023-algorithm-per-rule.md) relies on that: "a rule's ID is unique, so two algorithms never write the same key". Nothing stops two limiters from sharing a Redis and a rule ID, though, and the README suggests a second limiter: one before auth, by IP, and one after. Anonymous clients get the same `ip_…` ID in both.

The 1.0 security review tested two limiters on one Redis, each with a rule `global` of 3 a minute, and one client sending ten requests:

| Limiters | Allowed |
| --- | --- |
| Sliding window counter, then token bucket | 10 of 10 |
| Token bucket in both | 1 |

On two algorithms, each check finds the other's state under its key and deletes it, as [0016](0016-switching-algorithms-starts-fresh.md) says it should, so the client is never limited. On one algorithm, every request counts twice.

## Decision

`rateLimit` takes an optional `prefix`, which replaces `rl` at the start of every key: `{prefix}:{rule.id}:{clientId}`. It defaults to `rl`, so keys without one are what they were. It must be letters, digits, `_` and `-`. With no `:` in it, two different prefixes can never produce the same key, whatever the rule IDs. With no braces, Redis Cluster can't read it as a hash tag. `buildKey` takes the same prefix as an optional third argument. The README says to give each limiter that shares a Redis with another its own prefix.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Document that rule IDs must be unique across every limiter sharing a Redis | A rule ID that's natural in both limiters, such as `global`, is exactly the one that collides. Easy to miss, and silent when missed. |
| `rl:{prefix}:{rule.id}:{clientId}` | A limiter with prefix `a` and rule `b` would share keys with one without a prefix and rule `a:b`. Replacing `rl` keeps the first segment different for every limiter. |
| Detect two limiters with the same rule IDs at startup | Only works within one process, and two limiters on separate in-memory buckets share nothing, so it would warn on safe setups and miss limiters in other processes |
| A random or generated prefix per limiter | Every instance of an app must use the same keys to share a limit, so it has to be chosen, not generated |

## Evidence

- `test/integration/prefix.test.ts` reproduces the review's case against the test Redis: two limiters, two algorithms, one rule ID, and no `429` in ten requests. With a prefix on one of them, the limit holds at 3, and each key holds its own algorithm's state.
- `test/middleware.test.ts` checks the key the algorithm receives with and without a prefix, and that an empty prefix, `:`, braces, a space or a non-string throw at startup.
- Break checks: ignoring the prefix in the middleware fails one unit test and the integration test. Allowing `:` and braces fails two tests.

## Consequences

- An app with one limiter needs nothing. An app with two on one Redis sets a prefix on at least one of them.
- Changing a limiter's prefix gives its clients new keys, so they start once with a full limit, and the old keys expire on their own.
- Hook events and `buildKey` show the prefixed key, so tooling that reads keys must pass the same prefix.
