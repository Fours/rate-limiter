# 0019. Hooks get plain events, synchronously, and can't break a request

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 4

## Context

[0005](0005-metrics-through-hooks.md) decided that metrics go through two optional hooks, `onDecision` and `onFallback`, instead of a `prom-client` dependency. That leaves what the hooks are given, when they run, and what happens when one goes wrong. These are the inputs for `prometheusHooks()`, for logging fallbacks (0010), and for the benchmark app's measurements, so they have to carry enough to be useful without leaking what 0002 keeps out of logs and metrics.

## Decision

```ts
rateLimit({ rules, algorithm, hooks: { onDecision, onFallback } });
```

- **`onDecision`** gets `{ req, rule, limit, key, decision, source, durationMs }` once per limited request, after the decision and before the headers and response, for primary and fallback decisions alike.
- **`onFallback`** gets `{ req, rule, key, reason }`, plus `error` when `reason` is `'error'`, just before the fallback answers. So it runs before that request's `onDecision`. With `fallback: false` nothing falls back, so it isn't called.
- Requests that match no rule call neither hook.
- **`rule` is as configured, and `limit` is what the decision counted against.** During a fallback, `decision.remaining` counts against the scaled limit (0018). `limit` carries that scaled limit, so a hook can report remaining out of limit correctly, while `rule.id` stays the stable metric label.
- **`key` is the storage key,** so API keys are already hashed (0002). It can hold an IP, so it's not a metric label: that would leak client addresses and grow without bound.
- **`req` is the request as it arrived.** The caller already has it, and needs it to log a route or set a response header. It can hold a raw API key in its headers, which is the caller's to handle. None of the limiter's own fields holds one.
- **`durationMs` runs from entering the middleware to the decision,** from `performance.now()`, so it includes `identify`'s hashing and rule matching, like the benchmark app's `Server-Timing`. It's fractional milliseconds, an exception to "integer milliseconds internally": it's a measurement, not a limit, and the limiter's p50 of about 0.2 ms (0008) would round to zero.
- **Hooks are synchronous and can't break a request.** A hook that throws is caught and ignored. A hook that returns a promise isn't awaited, and its rejection is caught, so it's never an `unhandledRejection`. The limiter must never fail or slow a request for its own bookkeeping.
- `hooks`, and each hook in it, is checked at startup.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Await hooks | Every request would wait for the slowest metrics backend |
| Let a hook's error through to `next(err)` | A metrics bug would fail requests |
| Log a hook's error | The core doesn't log (0018). A caller who wants to know can catch inside their hook. |
| Leave `req` out | The caller couldn't log a route or set a header, and the benchmark app needs a header to mark fallback answers in milestone 4, T4 |
| Only `rule`, no `limit` | During a fallback, `decision.remaining` would be read against the wrong limit |
| Time only `algorithm.check` | Hides the cost of hashing in `identify`, and disagrees with `Server-Timing` |
| An `EventEmitter` | Rejected in 0005: less type-safe, and easy to leak listeners |

## Evidence

`test/middleware.hooks.test.ts`, through supertest against a real Express app:

- `onDecision` for allowed and denied decisions, from the primary and from the fallback, with the configured `rule` and the scaled `limit`
- `onFallback` with `reason: 'error'` and the error, or `reason: 'timeout'` and no error (fake `setTimeout`), always before `onDecision`; not called with `fallback: false`
- neither hook for a request no rule matches
- hooks that throw, or return a rejected promise, on both paths: the same status, `RateLimit-Remaining`, `Retry-After` and body as with no hooks, and no `unhandledRejection`
- a request with a raw `x-api-key`: the key appears in no field but `req`, and `key` holds its 16-character hash
- `durationMs` is finite and not negative, without depending on its value
- startup errors for a non-object `hooks` and for non-function hooks; either hook alone works

The middleware contract suite adds that `onDecision` reports exactly the decisions the algorithm returned, with `source: 'primary'`, for the in-memory bucket and all five Redis algorithms.

## Consequences

- `prometheusHooks()` (milestone 4, T2) builds its three metrics from these events alone.
- Events are part of the public API once the package is published, so adding fields is easy and removing them isn't.
- A hook that does slow synchronous work still slows every request: the README has to say so.
