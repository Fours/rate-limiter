# 0001. One async `Algorithm.check` for every algorithm and store

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 1

## Context

Milestone 1 builds an in-memory token bucket. Milestone 2 adds five Redis-backed algorithms. The middleware and the benchmarks should not change when the algorithm or the store changes.

## Decision

Every algorithm implements `check(key, rule): Promise<Decision>`, where `Decision` is `{ allowed, remaining, resetMs }`. The in-memory version returns a Promise too. Stores and clocks are passed in when an algorithm is built, never through `check`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A synchronous `check` for in-memory, and a separate async one for Redis | Two code paths in the middleware, and benchmarks that compare different things |
| Passing the Redis client into `check` (as in the plan's first sketch) | Leaks the store into the interface, and in-memory algorithms would have to ignore it |

## Evidence

The middleware tests in milestone 1 run against the in-memory algorithm. In milestone 2, the same tests should pass against every Redis algorithm without changes to `src/middleware.ts`.

## Consequences

The in-memory path pays for one microtask per check, which is negligible next to an HTTP request. The milestone 3 benchmarks can swap algorithms by changing one line.
