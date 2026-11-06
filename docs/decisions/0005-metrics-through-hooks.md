# 0005. Metrics through hooks, not a `prom-client` dependency

- **Status:** Accepted (the design). Built in milestone 4.
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

The milestone 4 tests check that the hooks are called with the right arguments. The `npm pack` output shows `prom-client` is not in `dependencies`.

## Consequences

Adding another backend later, such as OpenTelemetry, is another small adapter with no change to the core.
