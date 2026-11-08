# 0023. Rules can name their algorithm, from names the caller chooses

- **Status:** Accepted. Rule IDs are unique only within one limiter: two limiters on one Redis need their own prefixes ([0028](0028-key-prefix-per-limiter.md)).
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

Until now one middleware had one algorithm, for every rule. Milestone 3's benchmarks showed the algorithms cost the same per request, but differ in memory and accuracy in ways that depend on the rule ([0008](0008-sliding-window-accuracy-vs-cost.md)). A strict low limit, such as 5 login attempts a minute, wants the exact sliding window log, at 400 bytes a key. A high-volume rule at 1,000 a minute wants the sliding window counter, at 192 bytes rather than the log's 103 KB. Mixing them needed two middlewares and two sets of rules. Like `burst` ([0022](0022-burst.md)), choosing per rule changes the rules API, so it had to land before the first npm release.

## Decision

Rules take an optional `algorithm`, a name. `rateLimit` takes an `algorithms` option, an object of algorithms by name, and keeps `algorithm` as the default for rules that name none:

```ts
rateLimit({
  rules, // { id: 'login', ..., algorithm: 'exact' }
  algorithm: createRedisSlidingWindowCounter({ client }),
  algorithms: { exact: createRedisSlidingWindowLog({ client }) },
});
```

- **The names are the caller's.** Rules files are data, and algorithms are built objects with Redis clients inside them, so a file can only refer to one by name. Any non-empty string will do. No name is reserved, so a rule without `algorithm` gets the default, and a caller who wants a name for the default adds it to `algorithms` too.
- **Resolved at startup.** Each rule is matched to its algorithm once, when `rateLimit` is called. A name that isn't in `algorithms` throws an `InvalidRuleError` naming the rule and the names there are, whether the rule came from code or a file. Names come only from the object's own keys, so `toString` and the like can't match. Names no rule uses are allowed, since one set of algorithms may serve rules files that differ by environment.
- **Still one interface** ([0001](0001-async-algorithm-interface.md)). The middleware calls `check(key, rule)` on the matched rule's algorithm. Nothing in it depends on which algorithm that is.
- **Keys don't change.** A rule's ID is unique, so two algorithms never write the same key unless the operator moves a rule from one to another. Then the new algorithm finds the other one's state and starts the client fresh, once ([0016](0016-switching-algorithms-starts-fresh.md)).
- **The burst check is per rule.** A rule with a `burst` is checked against its own algorithm's `supportsBurst`, not the default's.
- **The fallback is unchanged:** the one in-memory token bucket for every rule ([0018](0018-timeout-and-fallback-in-the-middleware.md)), whatever each rule's primary algorithm.
- **`close()` closes only what the middleware created:** the default token bucket when no `algorithm` was given, and the fallback. Algorithms in `algorithms` are the caller's and may be shared.

## Alternatives considered

| Option | Why not |
| --- | --- |
| An algorithm object directly on a rule, in code | Rules would have two shapes, one for code and one for files ([0015](0015-rules-files.md)), and a rule couldn't be logged or compared as plain data. |
| Fixed names (`'token-bucket'`, `'sliding-window-log'`, ...) built from one client | Works only for the built-in Redis algorithms, not in-memory or custom ones, and every rule would share one client. A helper that builds all five can still come later, returning an object to pass as `algorithms`. |
| A reserved name for the default, such as `'default'` | A name the caller can't use, for something already meant by leaving the field out. |
| Throw for names no rule uses | Breaks one set of algorithms shared across environments whose rules differ. The core has no logging to warn with ([0005](0005-metrics-through-hooks.md)). |
| A middleware per algorithm | What callers had to do before. Each needs its own rules, and the most-specific match only works within one set. |

## Evidence

- `test/middleware.test.ts`, with recording fake algorithms through supertest: a rule naming an algorithm is checked by it and a rule naming none by the default. The in-memory default limits rules that name none when only `algorithms` is given. An unknown name throws at startup, from code and from a parsed rules file, listing the known names. A name from the prototype doesn't match. Unused names are allowed. A malformed `algorithms` throws. `close()` leaves named and given algorithms alone and stops the default it created. A burst is checked against the rule's own algorithm, both ways round.
- `test/integration/per-rule.test.ts`, against the test Redis:
  - **Two algorithms side by side:** a fixed-window rule and a sliding-window-log rule in one middleware each allow 3. Across the boundary the fixed window allows 3 more and the log none. Each key holds its own algorithm's structure.
  - **A moved rule:** a rule used up under the fixed window and then moved to the log gives its client the limit once more, and the key becomes the log's.
- `test/rules.test.ts`: `algorithm` must be a non-empty string.
- Breaking the code made a test fail each time. The breaks were:
  - every rule checked by the default
  - the burst checked against the default
  - unknown names quietly using the default
  - `close()` closing named algorithms
  - names looked up through the prototype

## Consequences

- One middleware can give each rule the algorithm that suits it, from code or a rules file, with no cost per request.
- A typo in a rule's algorithm name fails at startup, not on the first request.
- An operator who moves a rule to another algorithm gives its clients one fresh limit, as with switching the default (0016). The README says so.
- Hooks and metrics still identify rules by ID. A rule's algorithm is on the rule in each event, but the Prometheus labels don't include it.
