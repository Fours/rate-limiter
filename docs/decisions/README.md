# Design decisions

Each file here records one design choice: the choice itself, the alternatives, and the evidence for it. Together they become the public design write-up in milestone 5, so write them for a reader, not just as notes to yourself.

## How to add one

1. Copy `template.md` to `NNNN-short-title.md`, using the next free number.
2. Set the status:
   - **Proposed** means it's planned but not proven yet.
   - **Accepted** means it's backed by evidence or built.
   - **Superseded by NNNN** means a later record replaced it. Don't delete old records, and don't rewrite their history.
3. Add a row to the index below.
4. Put raw benchmark output in `data/`, named after the record (for example `data/0007-k6-2026-12-01.json`), and link it from the Evidence section. Every set of numbers states the machine, Node, Redis and k6 versions, and the exact command, so it can be rerun.

When you change a decision, update its record in the same commit as the code.

## Index

| # | Decision | Status | Milestone |
| --- | --- | --- | --- |
| [0001](0001-async-algorithm-interface.md) | One async `Algorithm.check` for every algorithm and store | Accepted | 1 |
| [0002](0002-hash-api-keys.md) | Hash API keys before they reach storage keys | Superseded by 0026 | 1 |
| [0003](0003-reset-semantics.md) | What `resetMs` means when allowed vs denied | Accepted | 1 |
| [0004](0004-limit-in-app-middleware.md) | Limit in app middleware, not at the load balancer | Accepted | 1 |
| [0005](0005-metrics-through-hooks.md) | Metrics through hooks, not a `prom-client` dependency | Accepted | 1, 4 |
| [0006](0006-atomic-lua-checks.md) | Each check is one Lua script via `EVALSHA` | Accepted | 2 |
| [0007](0007-redis-server-time.md) | Use Redis `TIME` inside scripts, not app time | Accepted | 2 |
| [0008](0008-sliding-window-accuracy-vs-cost.md) | Sliding window log vs counter: accuracy vs cost | Accepted | 3 |
| [0009](0009-latency-budget-prefetch.md) | Local token pre-fetching to cut Redis round trips: not shipped | Accepted | 3 |
| [0010](0010-fail-open-with-local-fallback.md) | Fail open with a local fallback when Redis is down | Accepted | 4 |
| [0011](0011-match-paths-like-express.md) | Match paths and methods the way Express routes them | Superseded by 0027 | 1 |
| [0012](0012-rate-limit-header-format.md) | Three `RateLimit-*` headers in seconds from now, `Retry-After` at least 1 | Accepted | 1 |
| [0013](0013-bring-your-own-redis-client.md) | The caller brings their own Redis client | Accepted | 2 |
| [0014](0014-leaky-bucket-as-gcra.md) | The leaky bucket is a burst-free GCRA | Accepted; a burst is optional from 0022 | 2 |
| [0015](0015-rules-files.md) | Rules files: one shape, strict fields, optional YAML | Accepted | 2 |
| [0016](0016-switching-algorithms-starts-fresh.md) | Switching algorithms starts each client fresh | Accepted | 2 |
| [0017](0017-how-the-benchmarks-measure.md) | How the benchmarks measure: the limiter's own cost via `Server-Timing`, three runs, no numbers in CI | Accepted; 2 ms resolution superseded by 0021 | 3 |
| [0018](0018-timeout-and-fallback-in-the-middleware.md) | The timeout and fallback live in the middleware, around any algorithm | Accepted | 4 |
| [0019](0019-hook-events.md) | Hooks get plain events, synchronously, and can't break a request | Accepted | 4 |
| [0020](0020-ipv6-by-64.md) | IPv6 clients are grouped by /64, and IPv4-mapped addresses count as IPv4 | Superseded by 0029 | 4 |
| [0021](0021-per-request-timing-tolerance.md) | The benchmarks give each request its own timing tolerance, from its limiter time | Accepted | 5 |
| [0022](0022-burst.md) | An optional `burst` on rules, for the token and leaky buckets only | Accepted | 5 |
| [0023](0023-algorithm-per-rule.md) | Rules can name their algorithm, from names the caller chooses | Accepted; across limiters, see 0028 | 5 |
| [0026](0026-no-unverified-api-keys.md) | The default identity never trusts an unverified API key | Accepted | 5 |
| [0027](0027-match-paths-as-handlers-read-them.md) | Match paths the way a decoding handler reads them | Accepted | 5 |
| [0028](0028-key-prefix-per-limiter.md) | Each limiter sharing a Redis gets its own key prefix | Accepted | 5 |
| [0029](0029-ipv4-in-ipv6.md) | IPv6 that carries IPv4 counts as IPv4 | Accepted | 5 |
