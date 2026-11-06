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
| [0002](0002-hash-api-keys.md) | Hash API keys before they reach storage keys | Accepted | 1 |
| [0003](0003-reset-semantics.md) | What `resetMs` means when allowed vs denied | Accepted | 1 |
| [0004](0004-limit-in-app-middleware.md) | Limit in app middleware, not at the load balancer | Accepted | 1 |
| [0005](0005-metrics-through-hooks.md) | Metrics through hooks, not a `prom-client` dependency | Accepted | 1, 4 |
| [0006](0006-atomic-lua-checks.md) | Each check is one Lua script via `EVALSHA` | Proposed | 2 |
| [0007](0007-redis-server-time.md) | Use Redis `TIME` inside scripts, not app time | Proposed | 2 |
| [0008](0008-sliding-window-accuracy-vs-cost.md) | Sliding window log vs counter: accuracy vs cost | Proposed | 3 |
| [0009](0009-latency-budget-prefetch.md) | Local token pre-fetching to cut Redis round trips | Proposed | 3, 4 |
| [0010](0010-fail-open-with-local-fallback.md) | Fail open with a local fallback when Redis is down | Proposed | 4 |
| [0011](0011-match-paths-like-express.md) | Match paths and methods the way Express routes them | Accepted | 1 |
