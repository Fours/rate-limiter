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
  analyse.ts          raw results → summary table and chart data
  run.ts              npm run bench: starts the stack per algorithm, runs k6, saves results
docker-compose.yml    the stack (docker-compose.test.yml stays as it is, for tests)
```

`bench/` joins `tsconfig.json`, ESLint and Prettier. If the pinned k6 runs TypeScript natively, the k6 scripts are TypeScript. If not, they're plain JavaScript and excluded from `tsc`.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T0. Benchmark app | Done | |
| T1. Compose stack | Not started | |
| T2. Analysis script | Not started | |
| T3. k6 scenarios and runner | Not started | |
| T4. Memory per key | Not started | |
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

- [ ] 30 requests through the load balancer being served by all three instances, according to `X-Instance`
- [ ] One client being held to its limit across the three instances: with `limit: 10`, exactly 10 of 30 allowed
- [ ] Two clients not affecting each other
- [ ] Redis not being reachable from the host

This is the milestone's demo, so the script lives in `bench/stack-check.sh` and prints a readable summary, like `examples/basic/demo-check.sh`.

### T2. Analysis script

`bench/analyse.ts`, before any real data exists, so the method is fixed before the numbers are seen.

**Done when** unit tests with hand-made records cover:

- [ ] The maximum allowed in any `windowMs` span: an exact limit, a 2× burst across a boundary, and spans that start between requests
- [ ] False denials, including none when the limit is respected exactly
- [ ] Percentiles (p50 and p99) on known samples, using one documented method
- [ ] The median of three runs
- [ ] A summary table in Markdown and chart data in JSON, from a small fixture directory

### T3. k6 scenarios and runner

`bench/k6/`, `bench/run.ts`, `npm run bench`.

Start with the k6 timestamp probe from "What gets measured", and record the result here.

**Done when:**

- [ ] The steady, ramp and edge-burst scenarios each run against the stack for one algorithm and write raw output and `setup.json`
- [ ] `npm run bench -- --algorithm fixed-window --scenario edges --quick` finishes in under a minute and the analysis shows overshoot above `limit`. That's the check that the edge-burst scenario actually hits a boundary.
- [ ] The same quick run against `sliding-window-log` shows no overshoot.
- [ ] Rerunning the analysis on saved output gives the same summary.

### T4. Memory per key

`bench/memory.ts`.

**Done when:**

- [ ] For each algorithm and each of the limits 10, 100 and 1,000 per minute, it fills one key to its limit and reports `MEMORY USAGE`, written to `docs/decisions/data/` with its setup
- [ ] A test checks that the sliding window log's memory grows with the limit and the counter's doesn't. That's the expected shape, and a quick check that the measurement measures something.

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

- [ ] CI builds the image, starts the stack, runs `bench/stack-check.sh`, runs one `--quick` edge-burst benchmark, and stops the stack. No numbers are compared in CI.
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
