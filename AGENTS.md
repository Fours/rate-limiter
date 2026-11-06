# AGENTS.md

Guidance for coding agents working in this repo.

## Project

This is a distributed rate limiter, shipped as a TypeScript middleware package for Express. It's a portfolio project meant to show backend and systems depth. Several app instances share limits through one Redis, with atomic Lua checks, five algorithms behind one interface, benchmarks, and a public design write-up.

- Package: `@kylewillett/rate-limiter`, a public scoped package on npm (`publishConfig.access` is `public`). It isn't published until milestone 5.
- Full plan: [Distributed rate limiter: project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C)
- Milestone specs: `docs/milestone-N.md`. **Work only on the current milestone.** Don't build features from later milestones early, but don't block them either.

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Single-process core: interface, in-memory token bucket, Express middleware | In progress — [spec](docs/milestone-1.md) |
| 2 | Redis store and all five algorithms (Lua via `EVALSHA`), rules from YAML or JSON | Not started |
| 3 | Docker Compose (load balancer, 3 instances, Redis), k6 load tests, benchmarks | Not started |
| 4 | 50 ms timeout and in-memory fallback, hooks, `prometheusHooks()`, Grafana, chaos test | Not started |
| 5 | npm publish, demo page, design write-up | Not started |

## Stack

- Node 22 or later, TypeScript in strict mode, ESM
- Express 5, as a peer dependency
- Vitest and supertest for tests
- ESLint and Prettier

## Commands

```bash
npm install
npm run lint
npm run typecheck
npm test            # vitest run
npm run coverage
npm run build       # tsc → dist/
npm run example     # examples/basic
```

Before you say a task is done, run lint, typecheck and test, and make sure all three pass.

## Layout

```
src/
  index.ts              public API: export only from here
  types.ts              Rule, Decision, Algorithm, Clock
  clock.ts
  algorithms/           one file per algorithm
  rules.ts              validation and most-specific matching
  identify.ts           client ID and storage key
  headers.ts
  middleware.ts
test/                   mirrors src/; helpers/ holds FakeClock
examples/basic/         runnable demo app
docs/                   milestone specs and design notes
```

## Rules that must hold

- **Every algorithm sits behind `Algorithm.check(key, rule): Promise<Decision>`.** Don't change the middleware to suit one algorithm. Stores and clocks are passed in when an algorithm is built, never through `check`.
- **Time is injected.** Algorithm code never calls `Date.now()` directly. It takes a `Clock`. From milestone 2 on, Redis scripts use Redis `TIME`, never app server time.
- **Atomicity.** From milestone 2 on, each check is a single Lua script run with `EVALSHA`. Never use a read-then-write pattern across round trips.
- **No `prom-client` or other metrics dependency in the core.** Metrics go through optional hooks. The Prometheus adapter is a separate entry point, with `prom-client` as an optional peer dependency.
- **Don't add runtime dependencies** beyond the Express peer dependency unless the milestone spec calls for one.
- **Don't store raw API keys anywhere.** Hash them before they go into storage keys, logs or metric labels.
- Storage keys look like `rl:{rule.id}:{clientId}`.
- Headers are `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds) on every limited request, plus `Retry-After` on a 429. The 429 body is `{ "error": "rate_limited" }`.
- Invalid configuration throws at startup, never at request time.

## Tests

- Use `FakeClock` for anything time-based. Never use real sleeps or timers in tests.
- Test middleware through supertest against a real Express app.
- Every behaviour listed in a milestone spec's "Done when" needs a test.
- Keep line coverage on `src/` at 90% or higher.

## Style

- Strict TypeScript: no `any`, and no non-null `!` unless a comment explains why.
- Keep integer milliseconds internally. Convert to seconds only at the header boundary.
- Keep functions small and pure where possible. I/O belongs at the edges.
- Write comments that explain why, not what.

## Design notes

Many choices here feed the public write-up: fail open vs closed, accuracy vs cost, latency budget, clock skew, atomicity, where the limiter runs, and dependencies. When you make or change one of these, record the choice, the alternative you rejected, and the evidence for it in `docs/decisions/`. Benchmark numbers belong there too.
