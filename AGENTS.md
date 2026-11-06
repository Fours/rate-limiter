# AGENTS.md

Guidance for coding agents working in this repo.

## Project

This is a distributed rate limiter, shipped as a TypeScript middleware package for Express. It's a portfolio project meant to show backend and systems depth. Several app instances share limits through one Redis, with atomic Lua checks, five algorithms behind one interface, benchmarks, and a public design write-up.

- Package: `@kylewillett/rate-limiter`, a public scoped package on npm (`publishConfig.access` is `public`). It isn't published until milestone 5.
- Full plan: [Distributed rate limiter: project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C)
- Milestone specs: `docs/milestone-N.md`. **Work only on the current milestone.** Don't build features from later milestones early, but don't block them either.
- Task status lives in the table at the top of each spec's "Tasks" section. When a task's "Done when" passes, mark it Done there and tick its `- [ ]` boxes in the same commit as the code. Fill in the Commit column with the short hash of the task's commit in the next commit, since a commit can't contain its own hash. When every task is done, update the milestone's row below and tick the spec's "Definition of done".

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Single-process core: interface, in-memory token bucket, Express middleware | Done — [spec](docs/milestone-1.md) |
| 2 | Redis store and all five algorithms (Lua via `EVALSHA`), rules from YAML or JSON | Done — [spec](docs/milestone-2.md) |
| 3 | Docker Compose (load balancer, 3 instances, Redis), k6 load tests, benchmarks | Not started — [spec](docs/milestone-3.md) |
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
npm test            # unit tests only, no Redis needed
npm run redis:up    # test Redis on port 6390 (docker-compose.test.yml)
npm run test:integration   # needs the test Redis
npm run coverage    # unit + integration, so it needs the test Redis too
npm run redis:down
npm run build       # tsc → dist/
npm run example     # examples/basic
```

Before you say a task is done, run lint, typecheck and test, and make sure all three pass. If the task touches Redis code, run `test:integration` and `coverage` too.

## Layout

```
src/
  index.ts              public API: export only from here
  types.ts              Rule, Decision, Algorithm, Clock
  clock.ts
  algorithms/           one file per algorithm
    redis/              Lua script + factory per Redis algorithm, copied to dist/ by scripts/copy-lua.js
  redis/                client adapters (public) and the script runner (internal)
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

- Use `FakeClock` for anything time-based. Never use real sleeps or timers in tests. Vitest fake timers are fine for code that schedules work, such as the sweep interval: fake only `setInterval` and `clearInterval`, so `FakeClock` still controls time.
- Test middleware through supertest against a real Express app.
- Integration tests live in `test/integration/` and run against a real Redis. Never flush the database (`FLUSHDB`, `FLUSHALL`): `REDIS_URL` might point at a Redis that isn't ours. Keep tests apart with `uniqueRuleId()` from `test/integration/helpers/redis.ts` instead.
- Every behaviour listed in a milestone spec's "Done when" needs a test.
- Keep line coverage on `src/` at 90% or higher.
- Prove that the important tests can fail. After a task's tests pass, temporarily break each key behaviour, such as a fix to the spec or a guard against bypassing a limit. Check that a test fails, then restore the code, and say in the commit message what you broke. Coverage shows that code ran, not that a test would notice it being wrong.
- Check library behaviour instead of assuming it. Before you design around how Express, Redis or Node behaves, run a quick probe against the installed version, for example a throwaway Express app that logs `req.baseUrl` and `req.path`. Then turn what you find into a test against the real library. Decision 0011 came from a probe like this.

## Style

- Strict TypeScript: no `any`, and no non-null `!` unless a comment explains why.
- Keep integer milliseconds internally. Convert to seconds only at the header boundary.
- Keep functions small and pure where possible. I/O belongs at the edges.
- Write comments that explain why, not what.

## Commits

- Never add an attribution line for Claude or any other AI to commit messages. That includes `Co-Authored-By: Claude ...` trailers and "Generated with ..." footers.

## Design decisions

`docs/decisions/` holds one numbered record per design choice: the context, the decision, the alternatives, the evidence and the consequences. These records become the public write-up in milestone 5. See `docs/decisions/README.md` for the format and the index.

- Read the related records before changing anything they cover, such as the interface, key format, headers, atomicity, time source or fallback.
- When you make or change a decision, add or update its record in the same commit as the code. Never rewrite an Accepted record. Supersede it with a new one instead.
- When a test or benchmark proves a Proposed record, fill in its Evidence section and change its status to Accepted.
- Raw benchmark output goes in `docs/decisions/data/`, with the setup recorded: machine, Node, Redis and k6 versions, and the exact command.
