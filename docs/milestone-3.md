# Milestone 3: Distributed setup and benchmarks

Source: [Distributed rate limiter: project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C), Milestones → 3.

## Outcome

One command starts the system the project plan draws: a load balancer in front of three app instances, all sharing one Redis. k6 drives traffic through it, and a repeatable benchmark measures each of the five algorithms on throughput, added latency, Redis memory and accuracy. The numbers settle [0008](decisions/0008-sliding-window-accuracy-vs-cost.md) and give the milestone 5 write-up its main chart.

**Demo at the end:** `npm run stack:up`, then send traffic through the load balancer and show it spread over three instances while one client is still held to one limit. Then show the benchmark table and the chart of allowed requests per window, with the fixed window's 2× burst at a boundary next to the sliding window log holding exactly to the limit.

## Scope

In scope:

- A benchmark app (`bench/app`), built into a Docker image from this repo's own `dist/`
- `docker-compose.yml`: a load balancer, 3 instances of the benchmark app, and Redis 7
- k6 scenarios for throughput and latency, and for bursts at window boundaries, run from a pinned k6 image
- A script that measures Redis memory per key
- An analysis script that turns raw output into a summary table and chart data, with unit tests
- Raw results in `docs/decisions/data/`, with the setup recorded as `docs/decisions/README.md` asks
- A CI smoke test of the stack, so it can't quietly rot
- A Benchmarks section in the README

Out of scope (later milestones):

| Item | Milestone |
| --- | --- |
| 50 ms timeout, in-memory fallback, chaos test ([0010](decisions/0010-fail-open-with-local-fallback.md)) | 4 |
| Hooks, `prometheusHooks()`, Prometheus and Grafana in the stack | 4 |
| Shipping token pre-fetching as a feature ([0009](decisions/0009-latency-budget-prefetch.md)), if the numbers justify it | 4 |
| The public demo page and the design write-up | 5 |
| Running the full benchmarks in CI (shared runners are too noisy to compare numbers) | Not planned |
| Redis Cluster or Sentinel | Not planned |

Design the stack so milestone 4 can add Prometheus, Grafana and a way to kill Redis without restructuring it. Milestone 5's demo page will probably sit behind the same load balancer.

**The library doesn't change in this milestone**, unless a benchmark finds a bug. Everything new lives in `bench/`, the compose file and scripts. If a benchmark exposes a bug, fix it in `src/` with a test, as in any other task.

## Design

### The stack

```
k6 ──> load balancer (nginx, :8080) ──> app-1 ─┐
                                    ──> app-2 ─┼──> Redis 7
                                    ──> app-3 ─┘
```

- **Load balancer:** nginx, round robin, no sticky sessions. Round robin is the worst case for a per-instance limiter and the normal case for a shared one, which is the point of the demo. nginx sets `X-Forwarded-For`, and the app sets `trust proxy` to 1, so `req.ip` is the client, not nginx (see "Behind a proxy" in the README).
- **App instances:** the same image three times, told apart by an `INSTANCE` environment variable. Each answers with an `X-Instance` header, so tests and the demo can see which instance served a request.
- **Redis:** `redis:7-alpine`, pinned to a minor version. No persistence (`--save '' --appendonly no`): benchmarks shouldn't measure disk writes, and the data is disposable. Its port isn't published, so nothing outside the stack writes to it. The memory script reaches it with `docker compose exec`.
- **Images are pinned** to exact versions, recorded in the compose file and in every results file.
- `npm run stack:up` builds the app image and starts the stack. `npm run stack:down` stops it and removes its volumes.

The stack runs on its own network and ports, so it can run next to the test Redis on 6390.

### The benchmark app (`bench/app/server.ts`)

`examples/basic` stays small, because it's written for readers. The benchmark app needs more:

- `ALGORITHM` picks any of the five Redis algorithms, or `none`, which mounts no limiter. `none` is the baseline that "added latency" is measured against.
- Rules come from `RULES` (a file path, loaded with `loadRules`). Each scenario passes its own rules file from `bench/rules/`.
- `GET /healthz` is mounted before the limiter, so health checks and k6 setup don't use up any client's limit.
- `GET /work` is the limited route. It does no work, so the numbers measure the limiter, not a handler.
- A **`Server-Timing: rl;dur=<ms>`** header gives the time spent in the limiter, measured inside the app with `performance.now()`, from entering the middleware to `next()` or the 429. That measures the limiter's own cost without network or load-balancer noise. End-to-end latency is measured too, by k6.
- `trust proxy` is 1, and the client is identified by `x-api-key`, so k6 can simulate many clients from one machine.

The app imports the package by name and runs against the built `dist/`, exactly as the example does.

### What gets measured

All for each of the five algorithms, plus `none` where it applies:

| Measure | How | Scenario |
| --- | --- | --- |
| Added latency, p50 and p99 | `Server-Timing` (the limiter alone), plus k6's `http_req_duration` compared with `none` (end to end) | Steady load: a constant arrival rate well below saturation, spread over 1,000 clients |
| Throughput | The highest arrival rate the 3-instance stack sustains with p99 under 50 ms and no errors, found by a ramping arrival rate | Ramp |
| Redis memory per key | `MEMORY USAGE` on a client's key after it has used its limit, at limits of 10, 100 and 1,000 per minute | No k6: `bench/memory.ts` runs checks directly against Redis |
| Overshoot | The most requests allowed for one client in any `windowMs`-wide span, against `limit` | Bursts at window edges, described below |
| False denials | Requests denied while fewer than `limit` had been allowed in the trailing `windowMs` | Same as overshoot |

50 ms is used for "sustains" because it's milestone 4's timeout ([0010](decisions/0010-fail-open-with-local-fallback.md)): beyond it, a real deployment would fall back anyway.

**Bursts at window edges.** A short window (`limit: 100`, `windowMs: 10_000`) keeps runs short. Each client sends a burst just before a 10-second boundary (on the clock, which is where the fixed window resets), another just after, and a steady trickle in between, for several windows. The expected overshoot for each algorithm follows from `maxPerWindow` in the milestone 2 behaviour suite: `limit` for the log and the leaky bucket, `2 × limit − 1` for the token bucket, and up to `2 × limit` for the fixed window and the sliding window counter. The benchmark shows how close real traffic gets.

Overshoot and false denials are computed from per-request records: client, time and status. **Probe k6 first:** check whether the timestamp in k6's JSON output marks when a request was sent or when its response arrived, and how far apart they are under load. Then decide whether to use k6's records or ones the app logs. Record what the probe found in this spec.

### Repeatability

- Each configuration runs three times. The summary reports the median, and the raw output keeps all three.
- `npm run bench` runs everything. `npm run bench -- --algorithm <name> --scenario <name>` runs one cell. Each run writes to `docs/decisions/data/0008-<scenario>-<date>/`, with a `setup.json` holding the machine, OS, CPU, Node, Redis, nginx and k6 versions, the git commit, and the exact command.
- The analysis script (`bench/analyse.ts`) reads only those files, so the summary can be rebuilt from the data without rerunning anything. It's pure, so it has unit tests with small hand-made inputs, including a burst whose overshoot is known.
- Docker on a laptop isn't a production cluster. The results say so, and compare algorithms with each other rather than claiming absolute numbers.

### Where things live

```
bench/
  app/server.ts       the benchmark app
  app/Dockerfile      multi-stage: build dist/, then run the app on node:22-alpine
  nginx.conf
  rules/              one rules file per scenario
  k6/                 one script per scenario
  memory.ts           Redis memory per key
  analysis.ts         the definitions: peak per window, false denials, percentiles, medians
  analyse.ts          raw results → summary table and chart data (npm run bench:analyse)
  run.ts              npm run bench: starts the stack per algorithm, runs k6, saves results
docker-compose.yml    the stack (docker-compose.test.yml stays as it is, for tests)
```

`bench/` joins `tsconfig.json`, ESLint and Prettier. If the pinned k6 runs TypeScript natively, the k6 scripts are TypeScript. If not, they're plain JavaScript and excluded from `tsc`.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T0. Benchmark app | Done | 3270a08 |
| T1. Compose stack | Done | 2c3f7e4 |
| T2. Analysis script | Done | 5d62967 |
| T3. k6 scenarios and runner | Done | eb16f6d |
| T4. Memory per key | Done | |
| T5. Run the benchmarks and decide 0008 | Not started | |
| T6. Token pre-fetching measurements | Not started | |
| T7. CI smoke test and README | Not started | |

### T0. Benchmark app

`bench/app/server.ts`, `bench/app/Dockerfile`, `bench/rules/`.

**Done when** tests (supertest, against the test Redis) cover:

- [x] Each `ALGORITHM` value building the right limiter, `none` mounting none, and an unknown value failing at startup
- [x] `/healthz` never being limited and never using up a client's limit
- [x] `Server-Timing` being present on limited and allowed responses, and absent with `none`
- [x] `X-Instance` naming the instance
- [x] With `trust proxy` 1, two clients behind one proxy getting separate limits through `X-Forwarded-For` and `x-api-key`
- [x] The Docker image building and answering `/healthz`

As built: `bench/app/app.ts` exports `createApp`, which the tests use directly, and `server.ts` only reads the environment. A probe on Express 5.3.0 confirmed that `json`, `send` and `end` all send headers through `res.writeHead`, so `Server-Timing` is set there. The tests check which script ran by reading the tag each script stores in Redis, so the app sends nothing a real app wouldn't. Under Vitest, the package name points at `src/`, so the bench tests run against the code under test, not the last build. The image runs `server.ts` with Node's type stripping on `node:22.23.4-alpine`, and keeps the dev dependencies, because `ioredis` and `yaml` are dev dependencies here. `bench/app/image-check.sh` runs in its own CI job, `bench-image`, once rather than per Node version. Breaking each behaviour failed a test: mounting the limiter before `/healthz`, removing `trust proxy`, setting `Server-Timing` only through `next()`, and mapping `fixed-window` to another factory. The first break passed the `/healthz` test at first, because its rule only covered `/work`, so that test now uses a rule with no path, which matches every route.

### T1. Compose stack

`docker-compose.yml`, `bench/nginx.conf`, `npm run stack:up` and `stack:down`.

**Done when** a test script against the running stack shows:

- [x] 30 requests through the load balancer being served by all three instances, according to `X-Instance`
- [x] One client being held to its limit across the three instances: with `limit: 10`, exactly 10 of 30 allowed
- [x] Two clients not affecting each other
- [x] Redis not being reachable from the host
- [x] A client not getting new identities by forging `X-Forwarded-For` (added in T1: it's what `trust proxy` set to 1 is for)

This is the milestone's demo, so the script lives in `bench/stack-check.sh` and prints a readable summary, like `examples/basic/demo-check.sh`.

As built: `bench/stack-check.sh [algorithm ...]` checks the counter by default, recreating the stack for each algorithm, so each starts with an empty Redis. The leaky bucket expects 1 allowed, not 10. It passed for all five. The stack has its own Compose project name, `rate-limiter-stack`, so `stack:down` can't remove the test Redis, which lives in the same folder. Images are pinned to `redis:7.4.12-alpine` and `nginx:1.31.8-alpine`. nginx runs **one worker**, because each worker keeps its own place in the rotation: with `worker_processes auto`, 30 requests split 21/5/4. With one worker they split exactly 10/10/10. T3 should check that nginx's CPU isn't what limits throughput. `proxy_next_upstream off` stops nginx resending a request to another instance, which would count it twice. For the fixed window, the script waits out the last 5 s of a minute first, as `demo-check.sh` does. `docker compose port` prints `invalid IP:0` for an unpublished port, so the Redis check reads the container's port list instead. Each of these breaks failed the check aimed at it: a sticky load balancer (`ip_hash`), app-3 on its own Redis (20 of 30 allowed), Redis published on a host port, and nginx passing the client's `X-Forwarded-For` through unchanged. With the sticky load balancer, exactly 10 of 30 were still allowed, and only the check that requests reach all three instances caught it.

### T2. Analysis script

`bench/analyse.ts`, before any real data exists, so the method is fixed before the numbers are seen.

**Done when** unit tests with hand-made records cover:

- [x] The maximum allowed in any `windowMs` span: an exact limit, a 2× burst across a boundary, and spans that start between requests
- [x] False denials, including none when the limit is respected exactly
- [x] Percentiles (p50 and p99) on known samples, using one documented method
- [x] The median of three runs
- [x] A summary table in Markdown and chart data in JSON, from a small fixture directory

As built: the pure functions are in `bench/analysis.ts`, and `bench/analyse.ts` is the command line (`npm run bench:analyse -- <results-dir>`), which writes `summary.md` and `chart.json` next to the data. The definitions are in [0017](decisions/0017-how-the-benchmarks-measure.md). **T3 writes this layout**, whatever the k6 probe decides:

```
<results-dir>/setup.json
<results-dir>/<algorithm>/run-<n>/meta.json       { algorithm, scenario, run, limit, windowMs }
<results-dir>/<algorithm>/run-<n>/requests.jsonl  one { client, t, status, e2eMs, limiterMs? } per line
```

All the runs in one directory must share a scenario and rule, or loading fails. The fixture in `test/fixtures/bench/results` makes each median in the fixed-window row come from a different run, so a summary that took one run's numbers would fail. Its `summary.md` and `chart.json` are the expected output, checked by hand. Each of these breaks failed a test: a closed span, a trailing window that keeps `t − windowMs`, a percentile one rank high, the first run instead of the median, an SLO that admits exactly 50 ms, and a throughput that ignores errors.

### T3. k6 scenarios and runner

`bench/k6/`, `bench/run.ts`, `npm run bench`.

Start with the k6 timestamp probe from "What gets measured", and record the result here.

**Done when:**

- [x] The steady, ramp and edge-burst scenarios each run against the stack for one algorithm and write raw output and `setup.json`
- [x] `npm run bench -- --algorithm fixed-window --scenario edges --quick` finishes in under a minute and the analysis shows overshoot above `limit`. That's the check that the edge-burst scenario actually hits a boundary. (Tightened to at least 1.8× the limit, see below.)
- [x] The same quick run against `sliding-window-log` shows no overshoot.
- [x] Rerunning the analysis on saved output gives the same summary.

As built:

- **The k6 probe:** on k6 2.3.0, the timestamp in k6's JSON output is when the response arrived, not when the request was sent. So each scenario logs one `REC` line per request from the script, and `bench/records.ts` turns k6's console log into `requests.jsonl`.
- **Which clock times the windows** took three tries, recorded in [0017](decisions/0017-how-the-benchmarks-measure.md). k6's send time and the app's `performance` clock both made the sliding window log look over its limit, because neither matches the clock Redis decides by. Windows are now timed by `X-Received-At`, the app's `Date.now()` when the request arrives, and the analysis allows `RESOLUTION_MS` (2 ms) for Redis's whole-ms clock. Over 4 quick runs after the change, the log peaked at exactly 100 with no false denials.
- **The `edges` trickle** is jittered (150 to 250 ms), and bursts fall on every other boundary, so requests don't recur exactly one window apart.
- **`edges-check.sh` requires the fixed window to reach 1.8× the limit**, not just to go over it. With the bursts moved mid-window, the trickle alone reached 129 against 100, which "over the limit" didn't catch. The real runs reach 200. Quick runs took 34 to 40 s each.
- **The ramp's target is 30,000 req/s**, not 10,000. At 10,000 nothing saturated. At 30,000 the stack sustained about 16,500 req/s (p99 under 50 ms). The apps were at about 84% of a core each, nginx at 57% and Redis at 38%, so the single-threaded Node apps saturate first, not nginx's one worker (T1's question). `docker stats` samples are saved with each ramp run.
- **Runs:** each run recreates the stack, so it starts with an empty Redis. k6 runs in Docker on the stack's network as the current user, so it can write results on Linux too. A second run on the same day gets a `-2` directory. Quick runs go to `bench/results/`, which is gitignored. `setup.json` leaves out the hostname.
- **Breaking it on purpose:** each of these failed a check: bursts mid-window instead of at a boundary (after the 1.8× change), a summary that depends on when it was analysed, and the parser reading the two timestamps in the wrong order.

### T4. Memory per key

`bench/memory.ts`.

**Done when:**

- [x] For each algorithm and each of the limits 10, 100 and 1,000 per minute, it fills one key to its limit and reports `MEMORY USAGE`, written to `docs/decisions/data/` with its setup
- [x] A test checks that the sliding window log's memory grows with the limit and the counter's doesn't. That's the expected shape, and a quick check that the measurement measures something.

As built: `npm run bench:memory` builds, then measures against the test Redis (7.4.12, the same version as the stack's), and writes `memory.json`, `memory.md` and `setup.json` to [data/0008-memory-2026-11-06](decisions/data/0008-memory-2026-11-06/). The numbers are in [0008](decisions/0008-sliding-window-accuracy-vs-cost.md)'s Evidence. Its Decision and status wait for T5.

- **Two limits beyond the spec's**, 127 and 128, sit either side of the point where Redis stops storing a sorted set compactly. The log holds one entry per allowed request plus its tag member, so it crosses 128 entries at a limit of 128, not 129 as first assumed. That one entry takes it from 4,176 to 15,328 bytes. At 1,000 per minute it's 102,944 bytes, against 192 for the counter at any limit.
- **Every key is 35 bytes long**, like the README's example key, because `MEMORY USAGE` counts the key's name. The first run used long unique ids, which added 40 bytes to every cell.
- **`SAMPLES 0`** counts every entry. `SAMPLES 1` gave the same numbers at these sizes, so no test can tell them apart. It stays at 0 because it's exact by definition.
- **Breaking it on purpose:** each of these failed the test: filling the key only once, reading a different key, and never deleting keys. The test for leftover keys first matched an old key pattern, so it would have passed whatever happened. It now matches the keys the script actually writes.

### T5. Run the benchmarks and decide 0008

The full run on one machine, with nothing else heavy running.

**Done when:**

- [ ] All five algorithms and `none` have three runs of each scenario in `docs/decisions/data/`, with setup recorded.
- [ ] The summary table is in [0008](decisions/0008-sliding-window-accuracy-vs-cost.md)'s Evidence section, with a link to the data. 0008 records a decision and moves to Accepted.
- [ ] Any result that contradicts the behaviour suite's `maxPerWindow` (for example, the log overshooting) is treated as a bug: find it, fix it with a test, and rerun.
- [ ] The milestone 2 open questions that waited for these numbers each get an answer, written into this spec under "Open questions": a separate burst size, and choosing the algorithm per rule.

### T6. Token pre-fetching measurements

The evidence half of [0009](decisions/0009-latency-budget-prefetch.md). See open question 1 before starting.

**Done when:**

- [ ] For batch sizes 1, 5 and 20 with 3 instances: added latency (p50 and p99), Redis operations per second (from `INFO commandstats`), and worst-case overshoot
- [ ] 0009's Evidence section has the numbers. Its Decision says whether milestone 4 ships pre-fetching, and its status moves to Accepted.

### T7. CI smoke test and README

**Done when:**

- [ ] CI builds the image, starts the stack, runs `bench/stack-check.sh` and `bench/edges-check.sh`, and stops the stack. No numbers are compared in CI.
- [ ] The README gains a Benchmarks section: the summary table, what each number means, the machine they came from, and how to rerun them.
- [ ] The README's algorithm table links to the benchmark numbers.

## Definition of done

- [ ] T0 to T7 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `test:integration` and `build` all pass, locally and in CI, and the CI stack smoke test passes.
- [ ] Line coverage is still at least 90% for `src/`.
- [ ] Still no runtime dependencies other than the Express peer dependency. k6 runs from its Docker image, so it isn't an npm dependency.
- [ ] [0008](decisions/0008-sliding-window-accuracy-vs-cost.md) and [0009](decisions/0009-latency-budget-prefetch.md) are Accepted, with evidence and linked data.
- [ ] Every results directory in `docs/decisions/data/` has a `setup.json`, and the summary in the README can be rebuilt from the data with `bench/analyse.ts`.

## Decision records

New, Proposed until the tasks that build them are done:

- [0017](decisions/0017-how-the-benchmarks-measure.md) (written in T0): measuring the limiter's own cost with `Server-Timing` inside the app, not only end to end; round-robin nginx; k6 in Docker on the same machine; three runs and the median; and why CI doesn't compare numbers. Accepted after T5.

Updated:

- [0008](decisions/0008-sliding-window-accuracy-vs-cost.md): Evidence, Decision and status, from T4 and T5
- [0009](decisions/0009-latency-budget-prefetch.md): Evidence, Decision and status, from T6
- [0004](decisions/0004-limit-in-app-middleware.md): check, and add evidence if the stack shows the point it makes: a client held to one limit across instances, keyed by API key, which a load balancer couldn't do without knowing about keys

## Open questions

1. **How far T6 goes.** Measuring pre-fetching needs a prototype that reserves a batch of tokens in one check. The scripts would need a cost argument, so this is a change to every Lua script, not just to the benchmarks. Options:
   - Build the prototype in T6, as an internal, unexported wrapper plus a cost argument for the token bucket script only, and measure it.
   - Measure only the baseline (batch size 1) in T6: how much a Redis round trip costs. If that's already small next to 50 ms, record 0009 as "not worth it" and skip the prototype.

   Recommendation: the second. It's cheaper, and the answer is probably clear from the baseline. Build the prototype only if the baseline p99 is more than a few ms.
2. **nginx or HAProxy.** nginx is assumed. HAProxy has better built-in stats, but milestone 4 brings Prometheus anyway.
3. **The edge-burst window.** 10 seconds keeps runs short, but production limits are usually per minute. Is 10 s representative enough, or should one run per algorithm use 60 s?

Carried over from milestone 2, to answer in T5:

- **A separate burst size for rules.** The benchmarks show what each algorithm's burst costs in overshoot.
- **Choosing the algorithm per rule.** Decide whether the differences are big enough to justify an `algorithm` field in rules.
- **IPv6 per /64:** still milestone 4.
