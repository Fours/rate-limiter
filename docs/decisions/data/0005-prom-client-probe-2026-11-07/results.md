# prom-client: registries, duplicate names and buckets

Milestone 4, T2. How the installed `prom-client` registers metrics, what it does with a name registered twice, and which options it checks, before designing `prometheusHooks()` around it.

## Setup

- Apple M5 Pro, Darwin 25.4.0, Node v25.8.2 on the host, prom-client 15.1.3
- Command: `node docs/decisions/data/0005-prom-client-probe-2026-11-07/probe.mjs` from the repo root, after `npm install`. No Redis or Docker needed.

## Output

```text
global has a_total after new Counter():          true
custom has b_total:                              true
global has b_total:                              false
dup on custom throws:                            Error: A metric with the name b_total has already been registered.
dup on global throws:                            A metric with the name a_total has already been registered.
partial: x_total left behind:                    true
bad name throws:                                 Invalid metric name
leading digit throws:                            Invalid metric name
empty buckets:                                   no throw
unsorted buckets:                                no throw
NaN bucket:                                      no throw
dup bucket:                                      no throw
extra label throws:                              Added label "other" is not included in initial labelset: [ 'rule' ]
metrics() returns promise:                       true
getMetricsAsJSON promise:                        true
[{"value":1,"metricName":"lat_seconds_bucket","exemplar":null,"labels":{"le":0.001,"rule":"x"}},{"value":1,"metricName":"lat_seconds_bucket","exemplar":null,"labels":{"le":"+Inf","rule":"x"}},{"value":0.0005,"metricName":"lat_seconds_sum","labels":{"rule":"x"}},{"value":1,"metricName":"lat_seconds_count","labels":{"rule":"x"}}]
unsorted [0.2, 0.1], observe 0.15:               [[0.2,1],[0.1,1],["+Inf",1]]
named ESM import works:                          true
prom-client version:                             15.1.3
```

## What it means for `prometheusHooks()`

- A metric goes on the global `register` unless `registers: [registry]` is passed, so the adapter always passes it, and defaults to `register` itself.
- A second metric with the same name throws prom-client's own message, and the metrics created before it stay registered. The adapter checks all three names first, throws its own message, and registers nothing.
- prom-client accepts empty, unsorted, duplicate and NaN buckets. Unsorted buckets give wrong counts: 0.15 was counted under `le="0.1"`. The adapter rejects any buckets that aren't finite, positive and strictly increasing.
- Names are validated (`Invalid metric name`), but without saying which. The adapter checks `prefix` itself, so the error names the option.
- prom-client is CommonJS, and named ESM imports from it work.
- `metrics()`, `get()` and `getMetricsAsJSON()` return promises, which tests await.
