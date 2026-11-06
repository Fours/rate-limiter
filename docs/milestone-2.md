# Milestone 2: Redis and all five algorithms

Source: [Distributed rate limiter: project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C), Milestones → 2.

## Outcome

Several app instances share limits through one Redis. Each check is one atomic Lua script, run with `EVALSHA`, so two instances can't both take the last token. All five algorithms (token bucket, leaky bucket, fixed window, sliding window log and sliding window counter) sit behind the milestone 1 `Algorithm` interface, so the middleware doesn't change. Rules can be loaded from a JSON or YAML file.

**Demo at the end:** start Redis and two copies of `examples/basic` on different ports, both pointed at the same Redis. Hammer one copy until it limits, then show that the other copy limits the same client too. Swap the algorithm with one line and run it again.

## Scope

In scope:

- A minimal Redis client interface, with adapters for `ioredis` and `node-redis`. The library has no Redis dependency of its own.
- A script runner: SHA-1 computed locally, `EVALSHA`, and a retry with `EVAL` on `NOSCRIPT`
- Lua scripts for all five algorithms, each using one key with a TTL
- A shared behaviour suite that every algorithm, in memory or in Redis, must pass
- Proof of atomicity and of using Redis time: the evidence for [0006](decisions/0006-atomic-lua-checks.md) and [0007](decisions/0007-redis-server-time.md)
- Loading rules from JSON or YAML files
- Integration tests against a real Redis, locally and in CI
- The example app and README updated for Redis

Out of scope (later milestones):

| Item | Milestone |
| --- | --- |
| Docker Compose stack with a load balancer and 3 instances, k6, benchmarks | 3 |
| Choosing between the two sliding windows from benchmark data ([0008](decisions/0008-sliding-window-accuracy-vs-cost.md)) | 3 |
| Local token pre-fetching ([0009](decisions/0009-latency-budget-prefetch.md)) | 3, 4 |
| 50 ms timeout, in-memory fallback, hooks, Prometheus ([0010](decisions/0010-fail-open-with-local-fallback.md)) | 4 |
| Redis Cluster and Sentinel testing (the design stays compatible, see "Keys and TTLs") | Not planned |
| Hot-reloading rules | 5, optional |

Design for these without building them. In particular, a Redis algorithm's `check` must be something milestone 4 can wrap in a timeout, so it must not retry forever or swallow errors.

## Design

### Redis client ([0013](decisions/0013-bring-your-own-redis-client.md))

The library doesn't depend on a Redis client. The caller passes in the client they already use, and the library talks to it through a two-method interface:

```ts
export interface RedisScriptClient {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export function fromIoredis(client: IoredisLike): RedisScriptClient;
export function fromNodeRedis(client: NodeRedisLike): RedisScriptClient;
```

`IoredisLike` and `NodeRedisLike` are structural types that list only the methods the adapters call, so neither library is imported at runtime. Both libraries are dev dependencies, used to test the adapters against real clients.

Why: apps already have a Redis client with their own connection, TLS, auth and retry settings. A second client inside the library would mean a second connection pool and a runtime dependency, which AGENTS.md rules out without good reason. The adapters keep the two common clients one line away.

### Script runner

- Each script's SHA-1 is computed locally with `node:crypto` when the module loads. There's no `SCRIPT LOAD` round trip at startup, which keeps startup synchronous, in line with "invalid configuration throws at startup".
- `check` calls `EVALSHA`. If Redis replies `NOSCRIPT` (seen after `SCRIPT FLUSH`, a restart or a failover, as confirmed against Redis 7.4), it calls `EVAL` once, which also caches the script, and uses that result. Any other error is thrown, so the middleware's `next(err)` now, and the milestone 4 fallback later, can handle it.
- The reply must be an array of three integers, `[allowed, remaining, resetMs]`, with `allowed` 0 or 1 and the other two at least 0. Anything else throws a clear error rather than turning into a wrong decision.

### Lua rules for every script

- **Time** comes from `redis.call('TIME')`, as `sec * 1000 + floor(usec / 1000)` ms ([0007](decisions/0007-redis-server-time.md)). Redis 7 replicates script effects, so a script can read `TIME` and then write (confirmed on Redis 7.4). Redis 7 or later is required.
- **Integers only.** Redis truncates Lua numbers in replies toward zero (7.9 becomes 7, −2.5 becomes −2), so each script rounds explicitly, with `math.ceil` for times, before returning. As in milestone 1, state is kept in exact integer units.
- **No `tostring` on numbers.** It formats with 14 significant digits, so 9007199254740991 becomes `9.007199254741e+15`. Numbers passed directly to `redis.call` are written at full precision.
- **The high-water mark for time.** Each script stores the latest time it has seen and never goes backwards, so a failover to a replica with a slower clock can't refill the same span twice. This is the same rule as the in-memory token bucket.
- **Arguments:** `KEYS[1]` is the storage key. `ARGV` holds `limit` and `windowMs`, plus a time override that is empty in production (see "Testing time").

### Keys and TTLs

- **Each check uses exactly one key**, `rl:{rule.id}:{clientId}`, passed as `KEYS[1]`. That keeps the milestone 1 key format and makes every check safe for Redis Cluster, since a single key always sits in one slot. Algorithms that need two values store them as fields of one hash, not as two keys.
- **Every write sets `PEXPIRE`** to the moment the key's state stops mattering: when a bucket would be full, a window has ended, or every entry has aged out. Redis then cleans up idle clients, which replaces the in-memory sweep.

### Algorithms

Each one returns a `Decision`, with `resetMs` following [0003](decisions/0003-reset-semantics.md): when allowed, the time until the limit is fully restored; when denied, the time until the next request would be allowed.

| Algorithm | State (one key) | Allows | `resetMs` allowed / denied | TTL |
| --- | --- | --- | --- | --- |
| Token bucket | hash: `units`, `last` | up to `limit` at once, refilling `limit` per `windowMs` | until full / until one token | until full |
| Leaky bucket ([0014](decisions/0014-leaky-bucket-as-gcra.md)) | hash: `tat` (theoretical arrival time) | one request per `windowMs / limit`, no burst | until drained / until the next slot | until drained |
| Fixed window | hash: `window`, `count` | `limit` per window aligned to the epoch, so up to 2× across a boundary | until the window ends / until the window ends | until the window ends |
| Sliding window log | sorted set of request times | exactly `limit` in any `windowMs` | `windowMs` / until the oldest entry ages out | `windowMs` |
| Sliding window counter | hash: `window`, `curr`, `prev` | `prev × (remaining share of window) + curr < limit`, an estimate | until both counts have aged out / until the estimate drops below `limit` | until the end of the next window |

Details each script must get right:

- **Token bucket:** a port of the milestone 1 maths, unchanged: integer units, the high-water mark, and carrying over whole tokens when a rule's limit changes. The behaviour suite runs against both versions, so they can't drift apart.
- **Leaky bucket:** the GCRA ("virtual scheduling") form of the leaky bucket. It stores one timestamp, the theoretical arrival time, and admits a request only if it isn't earlier than that time. With no burst allowed, it smooths traffic to a steady rate, which is the point of offering it next to the token bucket. Without that, a leaky bucket used as a meter is the token bucket's maths in reverse, so it wouldn't be worth comparing in milestone 3. `remaining` is 1 when the next slot is open, otherwise 0.
- **Fixed window:** the window number is `floor(now / windowMs)`. A new window resets the count. Windows are aligned to the epoch on purpose, so the milestone 3 benchmarks can show the 2× burst at a boundary.
- **Sliding window log:** members must be unique even when two requests arrive in the same millisecond. Use the microsecond time from `TIME` plus the set's current size, which is unique because Redis runs scripts one at a time. Only allowed requests are recorded.
- **Sliding window counter:** the comparison is done in integer units (`prev × (windowMs − elapsed) + curr × windowMs` against `limit × windowMs`), so there's no float rounding. The denied `resetMs` is the smallest wait after which the estimate allows one more request, and the tests check that exact bound.

### Testing time ([0007](decisions/0007-redis-server-time.md))

Redis scripts can't use `FakeClock`, and AGENTS.md bans real sleeps in tests. An earlier version of 0007 said the tests would "control time through the window sizes", which would mean real waits. Instead:

- Each script takes an optional time override as its last argument. When it's empty, the script uses `TIME`. When it's set, the script uses that value instead.
- Only an internal factory, `createRedisAlgorithm(script, { client, clock? })`, can set it. The public factories (`createRedisTokenBucket({ client })` and the others) have no `clock` option and always send an empty override. So production code can't use app time, and tests drive Redis scripts with `FakeClock` like everything else.
- One test without the override checks that the scripts really use `TIME`: two checks with app clocks set ±2 s apart give the same decisions. This is also 0007's evidence.

### Behaviour suite

`test/contract/algorithm-contract.ts` exports `describeAlgorithm(name, setup, traits)`, a set of tests any `Algorithm` must pass. `setup` returns an algorithm, the `FakeClock` that drives it and an optional `close`, fresh for each test. `traits` records the documented differences:

- `burst(rule)`: how many requests a new key allows at once. That's `limit`, or 1 for the leaky bucket.
- `maxPerWindow(rule)`: the most requests any `windowMs`-wide span may allow under traffic faster than the limit. That's `limit` for the leaky bucket and the sliding window log, `2 × limit − 1` for the token bucket (a full burst plus what refills during the rest of the window), and `2 × limit` for fixed window and the sliding window counter.

It checks, for each algorithm:

- A new key allows exactly its burst size, with `remaining` counting down to 0, then denies.
- After a denial, waiting `resetMs` allows the next request, and waiting `resetMs − 1` doesn't. This holds for all five, since each computes the smallest correct wait.
- After an allowed request, waiting its `resetMs` gives back a full burst, which is what [0003](decisions/0003-reset-semantics.md) means by "fully restored".
- Denied requests are free: repeated denials return the same decision, and don't push back the next allowed time. Only allowed requests count, in every algorithm.
- `remaining` and `resetMs` are whole numbers and never negative.
- Separate clients and separate rules don't affect each other.
- A clock that goes backwards, and then returns, doesn't add capacity.
- Under traffic four times faster than the limit for five windows, no `windowMs` span allows more than `maxPerWindow`, and the busiest span reaches at least `limit`.
- When a rule shrinks under the same key, no more than the new burst is allowed.

The first three run with `limit: 1`, with 5 per minute, and with 48 per day, the case where float maths lands on 0.999… tokens.

Every rule in the suite uses `windowMs` of 60 s or more. Redis keys expire in real time even when tests drive time with `FakeClock`, so a short window could expire mid-test and quietly reset the state.

It runs against the in-memory token bucket and all five Redis algorithms. Redis-only tests also check the TTL on each key and that the key is gone once its state no longer matters.

### Rules from files ([0015](decisions/0015-rules-files.md))

```ts
export function parseRules(text: string, format: 'json' | 'yaml'): Promise<Rule[]>;
export function loadRules(path: string): Promise<Rule[]>; // format from .json, .yaml or .yml
```

- The file holds `{ rules: Rule[] }`. Wrapping the list in an object leaves room for top-level settings later.
- JSON uses `JSON.parse`. YAML uses the `yaml` package, an **optional peer dependency** loaded with a dynamic `import()`. If it isn't installed, `loadRules` throws a message saying to install `yaml`. JSON users install nothing extra.
- Rules are validated with the milestone 1 `validateRules`. Files also **reject unknown fields**, so a typo such as `limt` fails at startup instead of silently becoming "no limit". Errors name the file, the rule's position and its id.
- Both are async, because the YAML import is. They run before `rateLimit()`, so a bad file still fails at startup.
- **No per-API-key rules.** The project plan lists "API key" as a rule input. That's handled by mapping keys to tiers in `opts.tier`, as `examples/basic` already does. Raw API keys therefore never sit in a config file, in line with [0002](decisions/0002-hash-api-keys.md).

### Middleware

It doesn't change ([0001](decisions/0001-async-algorithm-interface.md)). The milestone 1 middleware tests are parameterised to run against every Redis algorithm as well, with the expected numbers taken from each algorithm's traits.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T0. Redis test setup | Done | c015cdd |
| T1. Redis client interface and script runner | Done | bc55049 |
| T2. Behaviour suite | Done | |
| T3. Redis token bucket | Not started | |
| T4. Fixed window | Not started | |
| T5. Sliding window log | Not started | |
| T6. Sliding window counter | Not started | |
| T7. Leaky bucket | Not started | |
| T8. Distributed correctness | Not started | |
| T9. Rules from files | Not started | |
| T10. Example app and README | Not started | |

### T0. Redis test setup

- `docker-compose.test.yml` with one `redis:7-alpine` service, for local runs
- A separate Vitest project for integration tests: `npm run test:integration`, which reads `REDIS_URL`. `npm test` stays fast and needs no Redis.
- CI gets a `redis:7` service container and runs the integration tests on Node 22 and 24.
- Dev dependencies: `ioredis` and `redis`

**Done when:** a test that sends `PING` through each client passes locally and in CI, and `npm test` still passes with no Redis running.

As built: the test Redis is published on port 6390, not 6379, so tests can't reach a Redis used for anything else. `npm run redis:up` and `redis:down` start and stop it. `test/integration/setup.ts` fails the run with a clear message if Redis is missing or older than 7, rather than skipping. `npm run coverage` runs both projects, and CI now runs it, so the 90% threshold is enforced there.

### T1. Redis client interface and script runner

`src/redis/client.ts` (the interface and both adapters) and `src/redis/scripts.ts` (the runner).

**Done when** tests cover:

- [x] Both adapters running a script against a real Redis
- [x] `EVALSHA` being used when the script is cached
- [x] Retrying with `EVAL` after `SCRIPT FLUSH`, exactly once
- [x] Other errors passing through unchanged
- [x] Malformed replies (wrong length, non-integers, negative values, `allowed` not 0 or 1) throwing

As built: the adapters check their client when created, so passing the `node-redis` client to `fromIoredis` (or the reverse) fails at startup with a message naming the right adapter. `NOSCRIPT` is detected by the message prefix, because the two clients throw different error classes for it. A probe found two things later tasks must respect: a Lua `nil` inside the returned table silently shortens the reply, and integers near 2^53 come back off by one, so `parseDecision` accepts only safe integers. Scripts in T3 to T7 must never return `nil` inside their result table.

### T2. Behaviour suite

`test/contract/algorithm-contract.ts` as described above, run against the in-memory token bucket.

**Done when:** the in-memory token bucket passes, and breaking it (for example, allowing one extra request) makes the suite fail.

As built: six breaks to the in-memory bucket were each caught by the property aimed at them: one extra request, a denied `resetMs` 1 ms short, an allowed `resetMs` 1 ms short, charging denied requests, no protection against a backwards clock, and a doubled refill rate.

### T3. Redis token bucket

`src/algorithms/redis/token-bucket.lua` and `createRedisTokenBucket({ client })`.

**Done when:**

- [ ] The behaviour suite passes against it, with the same traits as the in-memory version.
- [ ] Given the same sequence of checks and times, it returns exactly the same decisions as the in-memory version.
- [ ] The key's TTL equals the time until the bucket is full, and the key is gone after that.
- [ ] A limit change on the same key carries over whole tokens only.

### T4 to T7. The other four algorithms

One task each, in this order: fixed window, sliding window log, sliding window counter, leaky bucket. Each adds `src/algorithms/redis/<name>.lua` and `createRedis<Name>({ client })`.

**Each is done when:**

- [ ] The behaviour suite passes against it, with its documented traits.
- [ ] Tests cover the algorithm's own behaviour:
  - **Fixed window:** a reset at the boundary, and the 2× burst across it
  - **Sliding window log:** being exact across a boundary, and two requests in the same millisecond both counting
  - **Sliding window counter:** the weighted estimate at 0%, 50% and 100% of a window, and the exact denied `resetMs`
  - **Leaky bucket:** steady spacing, no burst, and `remaining` being 0 or 1
- [ ] Its TTL is checked.

### T8. Distributed correctness

**Done when** tests cover:

- [ ] 200 concurrent checks over 4 separate connections against `limit: 50` allowing exactly 50, for every algorithm except fixed window at a boundary, which allows at most its documented maximum
- [ ] A deliberately naive `GET`-then-`SET` token bucket in the test suite overshooting under the same load. This and the test above become the evidence for [0006](decisions/0006-atomic-lua-checks.md), and its status moves to Accepted.
- [ ] Two "instances" with app clocks set ±2 s apart giving the same decisions with Redis time, and different decisions through the internal app-time option. This becomes the evidence for [0007](decisions/0007-redis-server-time.md), and its status moves to Accepted.
- [ ] The milestone 1 middleware tests passing against every Redis algorithm, with no change to `src/middleware.ts`. This is the evidence promised in [0001](decisions/0001-async-algorithm-interface.md).
- [ ] Two Express apps sharing one Redis limiting the same client together

### T9. Rules from files

`src/rules-file.ts` with `parseRules` and `loadRules`, and `yaml` as an optional peer dependency.

**Done when** tests cover:

- [ ] Loading the same rules from JSON, `.yaml` and `.yml`
- [ ] Unknown fields, bad values and an empty or missing `rules` key, each with an error naming the file, position and id
- [ ] A clear error when `yaml` isn't installed
- [ ] An empty `rules` list being valid
- [ ] A missing file being an error, not "no rules"

### T10. Example app and README

- `examples/basic` uses `createRedisSlidingWindowCounter` when `REDIS_URL` is set, and the in-memory token bucket otherwise. Rules come from `examples/basic/rules.yaml`.
- An `ALGORITHM` environment variable picks any of the five, for the demo.
- The README gains: using Redis, the client adapters, choosing an algorithm (the table above, in plain words), loading rules from files, and the Redis 7 requirement.
- The CI example step also runs against the Redis service.

**Done when:** the demo described in "Outcome" works from a clean clone with `docker compose -f docker-compose.test.yml up -d`.

## Definition of done

- [ ] T0 to T10 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `test:integration` and `build` all pass, locally and in CI.
- [ ] Line coverage is at least 90% for `src/`. Lua isn't measured, which is why the behaviour suite exists.
- [ ] No runtime dependencies other than the Express peer dependency. `yaml` is an optional peer dependency. Redis clients are dev dependencies only.
- [ ] [0006](decisions/0006-atomic-lua-checks.md) and [0007](decisions/0007-redis-server-time.md) are Accepted, with evidence.
- [ ] The public API is exported only from `src/index.ts`. The internal `createRedisAlgorithm` and its `clock` option are not exported.

## Decision records

New, Proposed until the tasks that build them are done:

- [0013](decisions/0013-bring-your-own-redis-client.md): the caller brings their own Redis client, through a two-method interface and adapters. Accepted after T1.
- [0014](decisions/0014-leaky-bucket-as-gcra.md): the leaky bucket is a GCRA with no burst. Accepted after T7.
- [0015](decisions/0015-rules-files.md): rules files hold `{ rules: [...] }`, reject unknown fields, load YAML through an optional peer dependency, and have no per-API-key rules. Accepted after T9.

Updated:

- [0007](decisions/0007-redis-server-time.md): its Consequences now describe the test-only time override from "Testing time", instead of controlling time through window sizes. Done with this spec.
- [0006](decisions/0006-atomic-lua-checks.md) and [0007](decisions/0007-redis-server-time.md): evidence and status, from T8

Check, and supersede only if the algorithms disagree with it:

- **0003:** the table above maps every algorithm onto "until fully restored" and "until the next request". If any script can't honour that, write a new record rather than editing 0003.

## Open questions

Carried over from milestone 1:

- **A separate burst size for rules:** still no for this milestone. The leaky bucket is the burst-free option. Revisit after the milestone 3 benchmarks.
- **IPv6 per /64:** not in this milestone. It's about identity, not storage, so it fits better alongside milestone 4.

New:

- **Choosing the algorithm per rule.** This spec uses one algorithm per middleware. Choosing per rule (for example, an `algorithm` field in rules files) would help mixed APIs, but the milestone 3 benchmarks compare algorithms one at a time. Revisit after them.

