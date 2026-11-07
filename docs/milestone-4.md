# Milestone 4: Failure handling and observability

Source: [Distributed rate limiter: project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C), Milestones → 4, plus "Middleware request flow" and "Observability".

## Outcome

A Redis outage no longer becomes an API outage. Each check against Redis gets 50 ms. On a timeout or an error, the middleware answers from an in-memory fallback, scaled to the number of instances, and says so through a hook ([0010](decisions/0010-fail-open-with-local-fallback.md)). Operators see what the limiter is doing through two optional hooks, `onDecision` and `onFallback`, and a separate `prometheusHooks()` adapter, without the core depending on `prom-client` ([0005](decisions/0005-metrics-through-hooks.md)). A chaos test kills Redis under load and measures what happens, which turns 0010 from a plan into evidence.

**Demo at the end:** start the stack with Prometheus and Grafana, and drive steady k6 traffic through it. In Grafana, decisions flow and some clients are denied. Kill Redis: requests keep succeeding, the fallback panel jumps, and denials continue at about the same rate. Bring Redis back, and the fallback panel drops to zero within seconds.

## Scope

In scope:

- A per-check timeout (default 50 ms) and an in-memory fallback in the middleware, for every algorithm
- Two hooks, `onDecision` and `onFallback`, that do nothing by default
- `prometheusHooks()` at a second entry point, `@kylewillett/rate-limiter/prometheus`, with `prom-client` as an optional peer dependency
- `/metrics` in the benchmark app; Prometheus and Grafana in the stack, with a provisioned dashboard
- A chaos scenario: Redis killed, and Redis hung, under k6 load. Results in `docs/decisions/data/`, and a CI check of its behaviour
- IPv6 clients grouped by /64, carried over from milestones 2 and 3
- README sections on failure handling and metrics

Out of scope:

| Item | Where |
| --- | --- |
| npm publish, demo page, design write-up | 5 |
| An optional `burst` on rules, and an `algorithm` field per rule (answered yes in milestone 3, T5) | 5, before publishing (open question 7) |
| A circuit breaker that skips Redis for a while after repeated failures | Only if T4's numbers call for it. See open question 3. |
| Discovering the instance count at runtime | Not planned. It's configured. |
| OpenTelemetry, StatsD or other adapters | Not planned. Each would be another small adapter ([0005](decisions/0005-metrics-through-hooks.md)). |
| Redis Cluster or Sentinel | Not planned. The caller's client handles topology ([0013](decisions/0013-bring-your-own-redis-client.md)). |

## Design

### Timeout and fallback

```ts
rateLimit({
  rules,
  algorithm: createRedisSlidingWindowCounter({ client: fromIoredis(redis) }),
  timeoutMs: 50, // default
  fallback: { instances: 3 }, // default { instances: 1 }; false turns the fallback off
  hooks: { onDecision, onFallback },
});
```

- **In the middleware, around any algorithm.** The fallback applies the same way to all five and to a caller's own algorithm, so the rule that the middleware doesn't bend to one algorithm still holds. The middleware is also the only place that knows both where a decision came from and which hooks to call. The alternative, an `Algorithm` wrapper such as `withFallback(algorithm)`, is open question 1.
- **The timeout** races `algorithm.check` against a `setTimeout`. A synchronous throw, a rejection and a timeout all fall back. The timer is cleared as soon as the check settles, so no timers pile up.
- **A late result is dropped.** A timed-out check keeps running inside the Redis client and may still use up a token in Redis. That's accepted: it can only make the limit a little stricter. Its rejection is caught, so a check that fails after its timeout never becomes an `unhandledRejection`.
- **The fallback** is the in-memory token bucket, the only in-memory algorithm, whatever the primary is. It uses the same rule ID and key, with the limit scaled down to `max(1, ceil(limit / instances))`. Round robin spreads a client over the instances, so during an outage the client gets about `limit` in all. The headers on a fallback decision report the scaled limit, because `RateLimit-Remaining` counts against it.
- **Created on first use,** so a limiter whose Redis never fails holds no second bucket and no second sweep timer. `close()` stops it too.
- **`fallback: false`** keeps today's behaviour: the error goes to Express's error handler. That's for callers who would rather fail closed.
- **Only `algorithm.check` falls back.** An error in `identify`, `tier` or rule matching is a bug in the caller's code, not an outage, so it still goes to `next(err)`.
- **No logging in the core.** "Log it" in 0010 happens in the caller's `onFallback`. The example and the benchmark app log through it.
- `timeoutMs` must be a positive integer, and `instances` too. Bad values throw at startup.

**The Redis client matters as much as the timeout.** If the client queues commands while it reconnects, every check during an outage waits the full 50 ms, and the queue grows with traffic. **Probe first:** with the installed `ioredis` and `node-redis`, kill a Redis and pause one (`docker pause`), and record what a command does in each case: how fast it fails, whether it's queued, and how the client reconnects. Record what the probe finds in this spec, and give recommended client settings in the README (for example, turning off the offline queue).

*Probe (T0), ioredis 6.0.0 and node-redis 6.3.1 against Redis 7.4.12:* with the offline queue on, the default for both, commands to a killed or absent Redis queue until it's back, so every check would wait out the timeout. With it off (`enableOfflineQueue: false`, `disableOfflineQueue: true`) they fail in 0.1 ms or less. A paused Redis hangs commands whatever the settings, and they all run once it's back. So the timeout is the only thing that bounds a hung Redis, and each check sent meanwhile still lands. With its offline queue off, ioredis also refuses commands until its first connection is ready. Data and setup: [0018's probe](decisions/data/0018-client-probe-2026-11-06/results.md). Vitest fake timers (`setTimeout` and `clearTimeout` only) work with supertest, but `vi.waitFor` moves fake time on every poll, so tests wait for the timer with `setImmediate` instead (`test/helpers/timers.ts`).

### Hooks

```ts
interface DecisionEvent {
  readonly req: Request;
  readonly rule: Rule; // as configured, not scaled
  readonly key: string; // rl:{rule.id}:{clientId}, with API keys already hashed
  readonly decision: Decision;
  readonly source: 'primary' | 'fallback';
  /** Time in the limiter, from performance.now(). Fractional ms. */
  readonly durationMs: number;
}

interface FallbackEvent {
  readonly req: Request;
  readonly rule: Rule;
  readonly key: string;
  readonly reason: 'timeout' | 'error';
  readonly error?: unknown; // when reason is 'error'
}
```

- `onDecision` runs once per limited request, after the decision and before the response, for primary and fallback decisions alike. `onFallback` runs before it, when a check falls back. Requests that match no rule call neither.
- **Hooks are synchronous and can't break a request.** A hook that throws is caught, and the request carries on. Anything a hook returns, including a promise, is ignored (open question 4).
- **`durationMs` is fractional milliseconds,** an exception to "integer milliseconds internally". It's a measurement, not a limit, and the limiter's p50 is about 0.2 ms (0008), which whole milliseconds would round to zero. It's measured the same way as the benchmark app's `Server-Timing`.
- **No raw API keys:** `key` is the storage key, so API keys are already hashed (0002). It can hold an IP, so the README warns against using it as a metric label, which is also a cardinality problem.

### `prometheusHooks()`

```ts
import { prometheusHooks } from '@kylewillett/rate-limiter/prometheus';

rateLimit({ rules, algorithm, hooks: prometheusHooks({ registry }) });
```

| Metric | Type | Labels |
| --- | --- | --- |
| `ratelimit_decisions_total` | Counter | `rule`, `outcome` (`allowed` or `denied`), `source` |
| `ratelimit_fallback_total` | Counter | `rule`, `reason` |
| `ratelimit_check_seconds` | Histogram | `rule`, `source` |

- Labels are rule IDs and fixed values only, never clients, so the number of series is bounded by the rules.
- Options: `registry` (default: `prom-client`'s global registry), `prefix` (default `ratelimit_`) and histogram `buckets`. The default buckets fit sub-millisecond checks, from 0.1 ms to 100 ms.
- `prom-client` is an optional peer dependency and a dev dependency, never a dependency. The main entry point must not import it, even indirectly. The adapter has its own build entry, and `package.json` gets an `exports` entry for `./prometheus`.

### The stack

- The benchmark app mounts `GET /metrics` before the limiter, as it does `/healthz`. Hooks are on only when `METRICS=1`, so the milestone 3 benchmarks stay comparable. T3 measures what the hooks cost.
- Prometheus scrapes each app instance directly, not through nginx, which would round-robin the scrapes.
- Grafana starts with a provisioned Prometheus data source and dashboard, and anonymous read-only access for the demo. Panels: decisions per second by outcome, the denial ratio, fallbacks per second by reason, limiter p50 and p99, each broken down by instance.
- Both live in a compose profile, `observability`, so `npm run stack:up` and the benchmarks run without them (open question 5). `npm run stack:observe` starts the stack with them.
- Images are pinned to exact versions, as in milestone 3.

### The chaos test

A new k6 scenario, `chaos`: steady traffic from many clients, well under saturation, with a rule tight enough that some clients are denied. The runner injects the fault at fixed times and records when it did:

| Phase | What happens |
| --- | --- |
| 0–20 s | Normal |
| 20–40 s | Redis is down: `docker compose kill redis` in one case, `docker compose pause redis` in the other |
| 40–60 s | Redis is back: `start` or `unpause` |

Measured, per case and per algorithm, three runs each:

| Measure | Expected |
| --- | --- |
| Error rate (5xx, connection errors) | 0 throughout. That's what failing open means. |
| End-to-end p99 per phase | Kill: close to normal, if the client fails fast. Pause: about `timeoutMs` more, since every check waits for its timeout. |
| Peak per window, per client, around each change | Up to about 2× the limit. Fallback buckets start full when Redis goes away, and a restarted Redis has no data, since there's no persistence. |
| Time to recover | From Redis's return to the first decision from the primary again, read from a header the benchmark app sets in `onDecision` |

A killed Redis comes back with an empty script cache, so the run also proves the `NOSCRIPT` retry under load.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T0. Timeout and fallback | Done | |
| T1. Hooks | Not started | |
| T2. `prometheusHooks()` | Not started | |
| T3. Prometheus and Grafana in the stack | Not started | |
| T4. Chaos test and decide 0010 | Not started | |
| T5. IPv6 clients by /64 | Not started | |
| T6. CI and README | Not started | |

### T0. Timeout and fallback

Probe the two Redis clients first, as described under Design, and record what you find here. Then add `timeoutMs` and `fallback` to `rateLimit`. Write [0018](decisions/0018-timeout-and-fallback-in-the-middleware.md).

**Done when:**

- [x] A check that hangs falls back after `timeoutMs`, tested with a fake algorithm and Vitest fake timers (only `setTimeout` and `clearTimeout` faked)
- [x] A check that rejects, or throws synchronously, falls back at once
- [x] A check that settles in time clears its timer, and no timers are left behind
- [x] A check that rejects after its timeout causes no `unhandledRejection`
- [x] The fallback allows `max(1, ceil(limit / instances))` per window, and the headers report that limit
- [x] The fallback isn't created until the first failure, and `close()` stops it
- [x] With `fallback: false`, the error reaches Express's error handler, as in milestone 3
- [x] Errors from `identify`, `tier` and matching still go to `next(err)`, with or without a fallback
- [x] Bad `timeoutMs` and `instances` throw at startup
- [x] Integration: a Redis algorithm on an unreachable Redis falls back, with each client, using the settings the probe recommends

### T1. Hooks

Add `hooks: { onDecision, onFallback }`, with the event types exported from `src/index.ts`. Write [0019](decisions/0019-hook-events.md).

**Done when:**

- [ ] `onDecision` gets the event above for allowed and denied requests, from the primary and the fallback
- [ ] `onFallback` gets `reason: 'timeout'` or `'error'`, with the error, and runs before `onDecision`
- [ ] Neither runs for a request that matches no rule
- [ ] A hook that throws, or returns a rejected promise, doesn't change the response and causes no `unhandledRejection`
- [ ] No event holds a raw API key, tested with a request that sends one
- [ ] `durationMs` is a non-negative number. Tests don't depend on its value.
- [ ] Non-function hooks throw at startup

### T2. `prometheusHooks()`

Probe the installed `prom-client` first: how it registers metrics on the global registry and on a new one, and what it does when a metric name is registered twice.

**Done when:**

- [ ] Each metric in the table is recorded with the right labels, tested against a fresh `Registry`
- [ ] `prefix`, `registry` and `buckets` work, and bad values throw
- [ ] Calling `prometheusHooks()` twice on one registry throws a clear error, not `prom-client`'s
- [ ] `@kylewillett/rate-limiter/prometheus` resolves from the built package, tested against `dist/`
- [ ] Importing the main entry point doesn't load `prom-client`
- [ ] CI checks that `npm pack` ships the adapter and that `prom-client` isn't in `dependencies`
- [ ] [0005](decisions/0005-metrics-through-hooks.md)'s Evidence section is filled in

### T3. Prometheus and Grafana in the stack

**Done when:**

- [ ] With `METRICS=1`, the benchmark app serves `/metrics` before the limiter, and its tests show the counters move
- [ ] `npm run stack:observe` starts the stack with Prometheus and Grafana, and `npm run stack:up` still starts it without them
- [ ] A check script shows Prometheus scraping all three instances and `ratelimit_decisions_total` rising under traffic
- [ ] The dashboard is provisioned from files in `bench/grafana/` and opens without a login
- [ ] A steady benchmark with `METRICS=1` and without it shows what the hooks cost, recorded in 0005 with its data

### T4. Chaos test and decide 0010

Add the `chaos` scenario to the runner and the analysis. The new measures (error rate per phase, p99 per phase, peaks around each change, time to recover) are pure functions in `bench/analysis.ts` with unit tests, like milestone 3's.

**Done when:**

- [ ] The analysis has unit tests with hand-made inputs, including an outage with a known recovery time and a known peak
- [ ] `npm run bench -- --scenario chaos` runs both cases for every algorithm, three runs each, and writes to `docs/decisions/data/0010-chaos-<date>/` with a `setup.json`
- [ ] No request fails in any run, or else 0010 says why and what changed
- [ ] [0010](decisions/0010-fail-open-with-local-fallback.md) is Accepted, with the numbers, the data and the consequences, including the overshoot when Redis goes away and when it comes back
- [ ] Open question 3 (a circuit breaker) is answered from the pause case's p99

### T5. IPv6 clients by /64

`defaultIdentify` groups an IPv6 address by its /64, since one host usually gets a whole /64 and could otherwise use a new address for every request. IPv4-mapped addresses (`::ffff:1.2.3.4`) count as IPv4. Probe first: what `req.ip` looks like in Express 5 for IPv4, IPv6 and IPv4-mapped clients, directly and through `trust proxy`. Write [0020](decisions/0020-ipv6-by-64.md).

**Done when:**

- [ ] Two addresses in one /64 get the same client ID, and addresses in different /64s get different ones
- [ ] Compressed, expanded and zone-suffixed forms of one address give the same ID
- [ ] IPv4 and IPv4-mapped addresses give the same ID as today, so their stored buckets carry over
- [ ] A test through supertest and a real Express app shows `req.ip` reaching `defaultIdentify` in the form the probe found
- [ ] The README says IPv6 clients start fresh once, on upgrade, because their storage keys change

### T6. CI and README

**Done when:**

- [ ] CI runs a short chaos check against the stack (`bench/chaos-check.sh`): no failed requests while Redis is killed, fallbacks seen, and the primary back after Redis returns. As in milestone 3, it compares no latency numbers.
- [ ] The README gains Failure handling and Metrics sections: the options, the fallback's maths, recommended Redis client settings, the hooks, `prometheusHooks()`, and the dashboard
- [ ] The options table lists `timeoutMs`, `fallback` and `hooks`
- [ ] `examples/basic` logs fallbacks through `onFallback`

## Definition of done

- [ ] T0 to T6 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `test:integration` and `build` all pass, locally and in CI, and the CI stack and chaos checks pass.
- [ ] Line coverage is still at least 90% for `src/`.
- [ ] Still no runtime dependencies other than the Express peer dependency. `prom-client` is an optional peer dependency.
- [ ] [0010](decisions/0010-fail-open-with-local-fallback.md) is Accepted with chaos evidence, and [0005](decisions/0005-metrics-through-hooks.md) has its evidence.
- [ ] Every results directory in `docs/decisions/data/` has a `setup.json`.

## Decision records

New:

- [0018](decisions/0018-timeout-and-fallback-in-the-middleware.md) (T0): the timeout and fallback live in the middleware, around any algorithm; late results are dropped; the fallback is always the in-memory token bucket, scaled by `instances`; the Redis client settings the probe recommends
- [0019](decisions/0019-hook-events.md) (T1): what the events hold, why hooks are synchronous and can't break a request, and why `durationMs` is fractional
- [0020](decisions/0020-ipv6-by-64.md) (T5): IPv6 clients by /64, and what that does to stored keys

Updated:

- [0010](decisions/0010-fail-open-with-local-fallback.md): Evidence, Consequences and status, from T4
- [0005](decisions/0005-metrics-through-hooks.md): Evidence, from T2 and T3

## Open questions

1. **Middleware or wrapper.** The timeout and fallback could be an `Algorithm` wrapper, `withFallback(algorithm, { timeoutMs, instances, onFallback })`, which composes and keeps the middleware as it is. But then the fallback is easy to forget, the hooks are configured in two places, and `onDecision` can't tell where a decision came from without a new field on `Decision`. Recommendation: in the middleware, as above.

   *Answer (spec review): in the middleware.*
2. **The instance count.** `fallback.instances` defaults to 1, which is right for one instance and lets three instances allow 3× during an outage. Making it required for every caller would be wrong for in-memory users. Recommendation: default 1. The README says to set it, and `onFallback` makes an outage visible either way.

   *Answer (spec review): default 1.*
3. **A circuit breaker.** When Redis hangs rather than refusing connections, every request waits the full `timeoutMs` before it falls back. A breaker (after a few failures in a row, skip Redis for a second, then try one check) would remove that wait, at the cost of more state and another decision record. Recommendation: measure first. If the pause case's p99 is about 50 ms more than normal, as expected, decide in T4 whether that's acceptable, the way T6 of milestone 3 decided pre-fetching from its baseline.

   *Answer (spec review): measure first, and decide in T4.*
4. **Hook errors.** Swallowing a hook's error hides bugs in it. Letting it through means a metrics bug can fail requests. Recommendation: swallow, and say so in the README, because the limiter must never fail a request for its own bookkeeping.

   *Answer (spec review): swallow.*
5. **Observability in the default stack.** Always running Prometheus and Grafana makes the demo one command, but adds two containers to every benchmark and CI run. Recommendation: a compose profile.

   *Answer (spec review): a compose profile.*
6. **IPv6 here.** It's small and was pointed here twice, but it changes identity, not failure handling. Recommendation: keep it, as T5. It changes storage keys, so it should land before milestone 5's npm publish.

   *Answer (spec review): keep it, as T5.*
7. **`burst` and per-rule `algorithm`.** Both change the rules API, which is easier before the first npm release than after. Recommendation: add them to milestone 5's spec, ahead of publishing, rather than here.

   *Answer (spec review): in milestone 5's spec, before publishing.*
