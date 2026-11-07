# 0005. Metrics through hooks, not a `prom-client` dependency

- **Status:** Accepted. Built in milestone 4 (T1 hooks, T2 adapter); T3 adds what the hooks cost.
- **Date:** 2026-11-06
- **Milestone:** 1, 4

## Context

Operators need decision counts, fallback counts and latency. But a library that pulls in `prom-client` forces it on users who use OpenTelemetry, StatsD or nothing at all.

## Decision

The middleware calls optional hooks, `onDecision` and `onFallback`, which do nothing by default. A separate entry point, `@kylewillett/rate-limiter/prometheus`, exports `prometheusHooks()`, with `prom-client` as an optional peer dependency.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `prom-client` as a hard dependency | Extra weight and a global registry for every user |
| An EventEmitter | Less type-safe, and easy to leak listeners |
| No metrics at all | Takes away the Grafana demo and the evidence for other decisions |

## Evidence

- **The hooks** (milestone 4, T1): `test/middleware.hooks.test.ts` checks that `onDecision` and `onFallback` get the right events, for the primary and the fallback, and that a hook that throws changes nothing ([0019](0019-hook-events.md)).
- **The adapter** (T2): `test/prometheus.test.ts` records each metric through a real `rateLimit` and Express app, against a fresh `Registry`, and checks every label: decisions by `rule`, `outcome` and `source`, fallbacks by `rule` and `reason` (`error` and `timeout`), and check time in seconds by `rule` and `source`. No label holds a client. It also covers `prefix`, `registry` and `buckets`, and the startup errors for bad values.
- **Calling it twice:** prom-client throws on a duplicate name only when it meets it, after registering the metrics before it. `prometheusHooks()` checks all three names first, so a second call on one registry throws a message that says what to do, and registers nothing. prom-client also accepts unsorted buckets and then counts wrongly, so the adapter rejects them. Probe: [data/0005-prom-client-probe-2026-11-07](data/0005-prom-client-probe-2026-11-07/results.md), prom-client 15.1.3.
- **The core doesn't load `prom-client`:** `test/package/dist.test.ts` imports the built main entry in a fresh Node process with a resolve hook, and no module from `prom-client` is resolved. In the same way, `@kylewillett/rate-limiter/prometheus` resolves to `dist/prometheus.js` through `exports` and records metrics.
- **The package:** CI checks that `npm pack` ships `dist/prometheus.js` and its types, that `prom-client` isn't in `dependencies`, and that it's an optional peer dependency.
- Breaking each behaviour on purpose failed a test: swapped outcome labels, milliseconds not converted to seconds, no up-front name check, unsorted buckets accepted, the prefix left off one metric, the `registry` option ignored, the `reason` label dropped, and the main entry re-exporting the adapter.

What the hooks cost under load comes from T3's benchmark with and without `METRICS=1`.

## Consequences

Adding another backend later, such as OpenTelemetry, is another small adapter with no change to the core.
