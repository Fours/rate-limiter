# 0005. Metrics through hooks, not a `prom-client` dependency

- **Status:** Accepted. Built in milestone 4: the hooks (T1), the adapter (T2), and what they cost (T3).
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

### The hooks and the adapter (milestone 4, T1 and T2)

- **The hooks** (milestone 4, T1): `test/middleware.hooks.test.ts` checks that `onDecision` and `onFallback` get the right events, for the primary and the fallback, and that a hook that throws changes nothing ([0019](0019-hook-events.md)).
- **The adapter** (T2): `test/prometheus.test.ts` records each metric through a real `rateLimit` and Express app, against a fresh `Registry`, and checks every label: decisions by `rule`, `outcome` and `source`, fallbacks by `rule` and `reason` (`error` and `timeout`), and check time in seconds by `rule` and `source`. No label holds a client. It also covers `prefix`, `registry` and `buckets`, and the startup errors for bad values.
- **Calling it twice:** prom-client throws on a duplicate name only when it meets it, after registering the metrics before it. `prometheusHooks()` checks all three names first, so a second call on one registry throws a message that says what to do, and registers nothing. prom-client also accepts unsorted buckets and then counts wrongly, so the adapter rejects them. Probe: [data/0005-prom-client-probe-2026-11-07](data/0005-prom-client-probe-2026-11-07/results.md), prom-client 15.1.3.
- **The core doesn't load `prom-client`:** `test/package/dist.test.ts` imports the built main entry in a fresh Node process with a resolve hook, and no module from `prom-client` is resolved. In the same way, `@kylewillett/rate-limiter/prometheus` resolves to `dist/prometheus.js` through `exports` and records metrics.
- **The package:** CI checks that `npm pack` ships `dist/prometheus.js` and its types, that `prom-client` isn't in `dependencies`, and that it's an optional peer dependency.
- Breaking each behaviour on purpose failed a test: swapped outcome labels, milliseconds not converted to seconds, no up-front name check, unsorted buckets accepted, the prefix left off one metric, the `registry` option ignored, the `reason` label dropped, and the main entry re-exporting the adapter.

### What the hooks cost (milestone 4, T3)

The sliding window counter on the stack (nginx, three instances, one Redis), steady traffic from 1,000 clients at 100 per minute each, 60 s per run, three runs each, with `METRICS=1` and without. With it, every decision goes through `prometheusHooks()`: two counter increments and a histogram observation. Nothing scraped the apps, so this is the hooks' cost, not Prometheus's. The limiter's time comes from `Server-Timing`, which wraps the middleware, so it includes the hooks. Each cell is the median of three runs, with the range across runs in brackets. The method is [0017](0017-how-the-benchmarks-measure.md).

| Rate | Metrics | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) |
| --- | --- | --- | --- | --- | --- | --- |
| 500 req/s | off | 0.19 | 0.72 | 0.58 | 1.85 | 501 |
| 500 req/s | on | 0.19 | 0.73 | 0.55 | 1.86 | 501 |
| 15,000 req/s | off | 0.12 | 0.94 (0.93–0.95) | 0.34 | 2.80 (2.79–2.96) | 15,018 |
| 15,000 req/s | on | 0.12 | 0.97 (0.83–1.09) | 0.35 | 2.98 (2.22–3.85) | 15,013 |

- **No measurable cost.** The limiter's p50 is the same to 0.01 ms at both rates. Its p99 moves by 0.01 to 0.03 ms, inside the spread from run to run, and throughput is unchanged. Redis round trips are exactly 1.000 per request either way.
- **The peak per window differs, but not because of the hooks.** At 15,000 req/s it was 110 to 151 without metrics and 152 to 182 with. Hooks don't change decisions. The sliding window counter's fixed windows align to the minute, and its overshoot grows with how far into the minute a client's burst starts. Each run started about 9 s later in the minute than the one before (6.6 s → 110, 15.5 s → 125, 31.7 s → 152, 40.6 s → 167, 49.6 s → 182), and the runs with metrics happened to come later in the minute. A run starting at 57.7 s gave 151, since its first window was only 2.3 s long. The counter's overshoot is [0008](0008-sliding-window-accuracy-vs-cost.md)'s subject.

Setup: Apple M5 Pro, Docker 29.4.1 (18 CPUs, 8 GiB), Node 22.23.4 in the app image, Redis 7.4.12, nginx 1.31.8, k6 2.3.0, prom-client 15.1.3, at commit `0756b6a` plus T3's changes, so `setup.json` says `uncommittedChanges: true`. Commands: `npm run bench -- --scenario steady --algorithm sliding-window-counter --rate 500 --decision 0005`, then the same with `--metrics`, then both at `--rate 15000`. Raw data: [500 req/s](data/0005-steady-500rps-2026-11-07/), [500 req/s with metrics](data/0005-steady-500rps-metrics-2026-11-07/), [15,000 req/s](data/0005-steady-15000rps-2026-11-07/), [15,000 req/s with metrics](data/0005-steady-15000rps-metrics-2026-11-07/). As in 0009, git keeps the 15,000 req/s summaries, spreads, Redis calls and k6 summaries, and the per-request records stay on the machine that ran them.

### The demo stack (T3)

`bench/observe-check.sh`, run in CI, starts the stack with Prometheus and Grafana. It checks that Prometheus scrapes `app-1` to `app-3` directly, that `ratelimit_decisions_total` rises under traffic on every instance, that Grafana serves the provisioned dashboard and reaches Prometheus with no login, and that a plain `stack:up` starts neither. Breaking anonymous access, turning metrics on by default, and scraping through nginx each made it fail.

## Consequences

Adding another backend later, such as OpenTelemetry, is another small adapter with no change to the core.
