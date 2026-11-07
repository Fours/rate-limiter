# @kylewillett/rate-limiter

Rate-limiting middleware for Express, with pluggable algorithms and standard `RateLimit-*` headers.

> **Status: milestone 3 of 5.** Limits can be shared by many app instances through one Redis, with five algorithms and rules loaded from YAML or JSON. All five are [benchmarked](#benchmarks) on a load-balanced stack of three instances. Timeouts and an in-memory fallback for when Redis is down come in milestone 4. The package is not on npm yet. See the [project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C) and the [milestone 3 spec](docs/milestone-3.md).

## Install

Once published:

```bash
npm install @kylewillett/rate-limiter express
```

Express 5 is a peer dependency. Node 22.23.4 or later on 22.x, or 24.22.1 or later on 24.x, is required: earlier patch releases have critical security bugs.

To share limits across instances, also install a Redis client: [`ioredis`](https://github.com/redis/ioredis) or [`redis`](https://github.com/redis/node-redis) (node-redis). The server must be **Redis 7 or later**. To load rules from YAML files, install [`yaml`](https://eemeli.org/yaml/). All three are optional, so nothing is installed that you don't use.

## Quick start

```ts
import express from 'express';
import { rateLimit } from '@kylewillett/rate-limiter';

const limiter = rateLimit({
  rules: [
    { id: 'global', limit: 100, windowMs: 60_000 },
    { id: 'login', limit: 5, windowMs: 60_000, method: 'POST', path: '/login' },
  ],
});

const app = express();
app.use(limiter);
app.post('/login', (req, res) => res.send('ok'));
app.listen(3000);

// On shutdown, after the server has closed:
limiter.close();
```

Each client gets 100 requests a minute, except `POST /login`, which gets 5. A client over its limit gets a `429` with `{ "error": "rate_limited" }`, and your handler doesn't run.

## Options

`rateLimit(options)` returns Express middleware with a `close()` method.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `rules` | `Rule[]` | required | The limits. A request uses the most specific rule that matches it. |
| `algorithm` | `Algorithm` | in-memory token bucket | How limits are counted. Anything with `check(key, rule): Promise<Decision>` works. |
| `identify` | `(req) => string` | API key, then user, then IP | Who the client is. See [Identifying clients](#identifying-clients). |
| `tier` | `(req) => string \| undefined` | no tier | The client's tier, for rules that set `tier`. |

`close()` stops the default token bucket's cleanup timer, so your process can exit cleanly. If you passed in your own `algorithm`, `close()` leaves it alone, because you may share it between limiters.

Invalid options throw when you call `rateLimit`, never during a request. Bad rules throw an `InvalidRuleError` that names the rule.

### Rules

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Unique. Used in the storage key. |
| `limit` | positive integer | Requests allowed per window |
| `windowMs` | positive integer | The window, in ms. For the token bucket, the time a used-up limit takes to refill completely. |
| `method` | `string`, optional | For example `POST`. Any method when absent. |
| `path` | `string`, optional | Exact, like `/orders`, or a prefix, like `/orders/*`. Any path when absent. |
| `tier` | `string`, optional | Matches the value from `options.tier`. Any tier when absent. |

The default algorithm is a token bucket: requests are refilled steadily, at `limit` per `windowMs`, rather than all at once when a window ends.

Paths and methods match the way Express routes them, so clients can't get around a rule by changing case, adding a trailing slash or sending `HEAD` instead of `GET`. `/orders/*` matches `/orders` itself and anything under it. When several rules match, the most specific wins: exact path, then wildcard path (longest first), then no path; then a rule with `tier` set; then a rule with `method` set; then the one declared first. A request that matches no rule isn't limited and gets no headers. The [spec](docs/milestone-1.md#rule-matching) has the full rules.

## Using Redis

On its own, the limiter counts in memory, so each process has its own limits. Behind a load balancer with three instances, a client would get three times its limit. Give every instance the same Redis and they share one count:

```ts
import { Redis } from 'ioredis';
import { createRedisSlidingWindowCounter, fromIoredis, rateLimit } from '@kylewillett/rate-limiter';

const redis = new Redis(process.env.REDIS_URL);
const limiter = rateLimit({
  rules,
  algorithm: createRedisSlidingWindowCounter({ client: fromIoredis(redis) }),
});
```

With node-redis, connect first and wrap the client with `fromNodeRedis`:

```ts
import { createClient } from 'redis';
import { createRedisSlidingWindowCounter, fromNodeRedis } from '@kylewillett/rate-limiter';

const redis = await createClient({ url: process.env.REDIS_URL }).connect();
const algorithm = createRedisSlidingWindowCounter({ client: fromNodeRedis(redis) });
```

You bring the client, already set up with your connection, TLS and auth, and you close it on shutdown: `limiter.close()` leaves it alone. Passing a client without its adapter throws at startup and says which adapter to use. Any object with `evalsha(sha, keys, args)` and `eval(script, keys, args)` works too ([0013](docs/decisions/0013-bring-your-own-redis-client.md)).

How it stays correct with many instances:

- **One round trip, atomic.** Each check is a single Lua script run with `EVALSHA`, so two instances can't both take a client's last request ([0006](docs/decisions/0006-atomic-lua-checks.md)).
- **One clock.** Scripts use Redis's own time, so instances whose clocks disagree still agree on the limit ([0007](docs/decisions/0007-redis-server-time.md)).
- **One key per client and rule,** `rl:{rule.id}:{clientId}`, with a TTL, so idle clients cost nothing. Switching algorithms on a live Redis starts each client fresh instead of misreading the old algorithm's state ([0016](docs/decisions/0016-switching-algorithms-starts-fresh.md)).

If Redis fails or takes longer than `timeoutMs` (default 50 ms), the request is answered from an in-memory token bucket instead, so a Redis outage isn't an API outage. Set `fallback: { instances: N }` to the number of instances sharing the limit, so each allows `limit / N` while Redis is down. `fallback: false` sends the error, or a `RateLimitTimeoutError`, to Express's error handler instead ([0018](docs/decisions/0018-timeout-and-fallback-in-the-middleware.md)).

Turn off your client's offline queue, so checks fail at once while Redis is unreachable instead of each waiting out the timeout: `new Redis(url, { enableOfflineQueue: false })` for ioredis, `createClient({ url, disableOfflineQueue: true })` for node-redis.

## Choosing an algorithm

All five use the same rules and headers. They differ in how a client's requests are spread over time:

| Algorithm | Create it with | A client can send | Good for | [Measured](#benchmarks) |
| --- | --- | --- | --- | --- |
| Token bucket | `createTokenBucket()` (memory, the default) or `createRedisTokenBucket()` | Up to `limit` at once, then refills steadily at `limit` per `windowMs` | Most APIs: short bursts are fine, the average rate is capped | [1.54× the limit at window edges; 160 B a key](#benchmarks) |
| Leaky bucket | `createRedisLeakyBucket()` | One request every `windowMs / limit`, with no burst | Smoothing traffic to a steady rate, for example in front of a fragile backend ([0014](docs/decisions/0014-leaky-bucket-as-gcra.md)) | [Never over; denies 23% of steady traffic under the limit; 176 B a key](#benchmarks) |
| Fixed window | `createRedisFixedWindow()` | `limit` per window, with windows starting on the clock (each minute, for a 60 s window) | The cheapest option, and easy to explain. A client can send up to 2× `limit` across a window boundary. | [2.00× the limit at window edges; 176 B a key](#benchmarks) |
| Sliding window log | `createRedisSlidingWindowLog()` | Exactly `limit` in any `windowMs`, measured back from now | Exact limits. Stores one entry per allowed request, so it costs the most memory. | [Never over; 400 B a key at 10 a minute, 103 KB at 1,000](#benchmarks) |
| Sliding window counter | `createRedisSlidingWindowCounter()` | About `limit` in any `windowMs`, estimated from two counts. It never allows more than `limit` by its estimate. | Close to exact at a fixed, small cost: a good default for Redis | [1.05× the limit at window edges (at most 1.43×); 192 B a key](#benchmarks) |

The leaky bucket surprises people: with `limit: 10, windowMs: 60_000` it allows one request every 6 seconds, so a client that sends 10 at once gets 1 through and 9 `429`s. That's the point of it: no bursts. If you want bursts, use one of the others.

The milestone 2 spec has the [exact maths and storage of each](docs/milestone-2.md#algorithms).

## Loading rules from files

Keep rules in a JSON or YAML file and load them at startup:

```yaml
# rules.yaml
rules:
  - id: global
    limit: 100
    windowMs: 60000
  - id: login
    limit: 5
    windowMs: 60000
    method: POST
    path: /login
```

```ts
import { loadRules, rateLimit } from '@kylewillett/rate-limiter';

const rules = await loadRules('config/rules.yaml');
const limiter = rateLimit({ rules });
```

- The format comes from the extension: `.json`, `.yaml` or `.yml`. YAML needs `npm install yaml`. Without it, loading a YAML file says so.
- The file holds an object with a `rules` list, not a bare list. An empty list is fine. A missing file is an error, never "no rules".
- **Unknown fields are rejected.** A typo such as `limt: 10` or `methd: POST` fails at startup instead of quietly removing a limit. Errors name the file, the rule's position and its id, for example `config/rules.yaml: rules[1] ("login"): unknown field "limt"`.
- `parseRules(text, format, source?)` does the same for text from anywhere else. `source` names it in errors.
- There are no per-API-key rules, so raw keys never sit in a config file. To give some keys other limits, map them to a tier with the `tier` option.

The design is in [0015](docs/decisions/0015-rules-files.md).

## Identifying clients

By default, a client is the first of these that the request has:

1. An `x-api-key` header, stored as `key_` plus a sha256 hash of the key, so raw keys never reach storage or logs
2. `req.user.id`, set by your auth middleware, as `user_<id>`
3. `req.ip`, as `ip_<ip>`, grouped as below
4. Otherwise `anon`

Empty values are skipped, so a blank header doesn't put every client in one bucket.

IPs are grouped so one client can't escape its limit by changing address ([0020](docs/decisions/0020-ipv6-by-64.md)):

- **IPv6 clients by /64:** `2001:db8:1:2::7` and `2001:db8:1:2:abcd::1` are both `ip_2001:db8:1:2::/64`. One home or server usually gets a whole /64, so it could otherwise use a new address for every request. Everyone in that /64 shares the limit, as everyone behind one IPv4 NAT does.
- **IPv4-mapped addresses as IPv4:** a server listening on `::`, Node's default, sees IPv4 clients as `::ffff:203.0.113.7`. That's `ip_203.0.113.7`, the same as on an IPv4-only server.
- Brackets, zones (`%eth0`), case and the way an address is abbreviated don't matter.

**Upgrading from an earlier version:** IPv6 clients, and IPv4 clients of a server listening on `::`, get new storage keys, so they start once with a full limit. Their old keys expire on their own.

### Behind a proxy or load balancer: set `trust proxy`

Without it, `req.ip` is the proxy's address, so **every client shares one limit**. Tell Express how many proxy hops to trust:

```ts
app.set('trust proxy', 1); // one load balancer in front of the app
```

Don't use `true` if clients can reach the app directly. Express would then believe any `X-Forwarded-For` header, and a client could pick a new identity on every request. See the [Express docs](https://expressjs.com/en/guide/behind-proxies.html).

### A custom `identify`

```ts
rateLimit({ rules, identify: (req) => `account_${lookupAccount(req)}` });
```

Two things to watch:

- **Return a non-empty string.** Every request that gets `''` shares one bucket.
- **Use a prefix that can't be confused with another rule's keys.** Storage keys are `rl:{rule.id}:{clientId}`, and rule ids may contain `:`. So rule `a` with client `b:ip_1` and rule `a:b` with client `ip_1` both give `rl:a:b:ip_1`. A fixed prefix like `account_`, with no `:` in it, avoids this.

## Headers

Every request a rule matches gets:

| Header | Meaning |
| --- | --- |
| `RateLimit-Limit` | The rule's `limit` |
| `RateLimit-Remaining` | Requests left right now |
| `RateLimit-Reset` | Allowed: seconds until the limit is completely refilled. Denied: seconds until the next request will be allowed. |

A denied request also gets `Retry-After`, in seconds, and a `429` with `{ "error": "rate_limited" }`.

All times are whole seconds from now, rounded up, so a client that waits the time it's told is never early. `Retry-After` is never below 1, so a denied client is never told to retry at once. The reasons are in decisions [0003](docs/decisions/0003-reset-semantics.md) and [0012](docs/decisions/0012-rate-limit-header-format.md).

## Try the demo

The demo's code is in [examples/basic/server.ts](examples/basic/server.ts), with its rules in [rules.yaml](examples/basic/rules.yaml).

### In memory

```bash
npm install
npm run example
```

Then, in another terminal:

```bash
examples/basic/hammer.sh 12
```

`RateLimit-Remaining` counts down from 9 to 0, then requests get `429` with `Retry-After`. Ordering is limited more tightly on the free tier:

```bash
examples/basic/hammer.sh 5 POST /orders
```

The 4th order gets a `429`. With the demo's pro key, only the global limit applies:

```bash
examples/basic/hammer.sh 5 POST /orders demo-pro-key
```

### Two instances sharing Redis

Start Redis (Docker, port 6390) and build once:

```bash
docker compose -f docker-compose.test.yml up -d
```

```bash
npm run build
```

Then start two copies of the server, each in its own terminal:

```bash
PORT=3001 REDIS_URL=redis://localhost:6390 npm run example:serve
```

```bash
PORT=3002 REDIS_URL=redis://localhost:6390 npm run example:serve
```

Use up the limit on one copy, then send a request to the other:

```bash
BASE_URL=http://localhost:3001 examples/basic/hammer.sh 11
```

```bash
BASE_URL=http://localhost:3002 examples/basic/hammer.sh 1
```

The second copy answers `429` too, because both count the same client in the same Redis.

With Redis, the demo uses the sliding window counter. Set `ALGORITHM` to `token-bucket`, `leaky-bucket`, `fixed-window`, `sliding-window-log` or `sliding-window-counter` on both copies to try another. With `leaky-bucket`, `hammer.sh 11` lets only the first request through, because the leaky bucket allows no burst (see [Choosing an algorithm](#choosing-an-algorithm)).

`examples/basic/demo-check.sh` runs this check for all five algorithms, the way CI does.

## Benchmarks

Every algorithm was measured on the stack in [docker-compose.yml](docker-compose.yml): nginx, round robin, in front of three app instances that share one Redis. k6 drives the traffic. The full results, the method and the reasoning are in decisions [0008](docs/decisions/0008-sliding-window-accuracy-vs-cost.md) (which algorithm), [0009](docs/decisions/0009-latency-budget-prefetch.md) (whether to pre-fetch tokens) and [0017](docs/decisions/0017-how-the-benchmarks-measure.md) (how it's measured).

**In short:** all five cost the same per request, about 0.7 ms at p99. They differ in accuracy and memory, so the sliding window counter is the default recommendation for Redis, and the sliding window log is the choice when a limit must be exact.

### Latency at a steady 500 req/s

1,000 clients, 100 requests a minute each, for 60 s, all well under their limits.

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | False denials |
| --- | --- | --- | --- | --- | --- |
| No limiter | – | – | 0.57 | 1.49 | – |
| Token bucket | 0.18 | 0.73 | 0.56 | 1.87 | 0.0% |
| Leaky bucket | 0.18 | 0.72 | 0.54 | 1.82 | 23.1% |
| Fixed window | 0.17 | 0.69 | 0.53 | 1.83 | 0.0% |
| Sliding window log | 0.19 | 0.75 | 0.57 | 1.92 | 0.0% |
| Sliding window counter | 0.18 | 0.73 | 0.56 | 1.84 | 0.0% |

### Accuracy at window edges

10 clients on a limit of 100 per 10 s. Each sends its full limit just before and just after a window boundary, plus a trickle in between. This is the traffic that tells the algorithms apart.

| Algorithm | Peak in any 10 s | Against the limit | False denials |
| --- | --- | --- | --- |
| Token bucket | 154 | 1.54× | 0.0% |
| Leaky bucket | 54 | never over | 70.3% |
| Fixed window | 200 | 2.00× | 0.0% |
| Sliding window log | 100 | never over | 0.0% |
| Sliding window counter | 105 (at most 143) | 1.05× | 14.6% |

### Throughput

The busiest second, on an arrival rate ramped from 100 to 60,000 req/s, while p99 stayed under 50 ms with no errors.

| Algorithm | Throughput (req/s) |
| --- | --- |
| No limiter | 47,721 |
| Token bucket | 39,260 |
| Leaky bucket | 38,804 |
| Fixed window | 40,432 |
| Sliding window log | 39,977 |
| Sliding window counter | 38,620 |

The three Node apps ran out of CPU first. Redis stayed at 60 to 78% of a core, so it wasn't the limit.

### Redis memory per key

`MEMORY USAGE` on one client's key after it has used its limit, in bytes.

| Algorithm | 10 a minute | 100 a minute | 1,000 a minute |
| --- | --- | --- | --- |
| Token bucket | 160 | 160 | 160 |
| Leaky bucket | 176 | 176 | 176 |
| Fixed window | 176 | 176 | 176 |
| Sliding window log | 400 | 3,152 | 102,944 |
| Sliding window counter | 192 | 192 | 192 |

### What the numbers mean

- **Limiter** latency is the time spent inside the middleware, from the app's `Server-Timing: rl;dur=…` header. It leaves out the network and nginx. **End-to-end** is k6's request duration through nginx. Compare it with the no-limiter row to see what the limiter adds: 0.3 to 0.4 ms at p99.
- **Peak in any 10 s** is the most requests one client got through in any window-wide span, measured from k6's per-request records. Over the limit means the algorithm let a burst through.
- **False denials** are `429`s sent while the client had fewer than `limit` allowed in the trailing window. The leaky bucket's are by design: it allows no burst, so two requests close together get the second denied.
- **Throughput** is for comparing algorithms, not for capacity planning: k6, nginx, the apps and Redis all share one laptop.
- Each latency, accuracy and throughput cell is the median of three runs. Memory doesn't depend on load, so it's one run.

### The machine

An Apple M5 Pro (18 cores, 24 GiB), with Docker 29.4.1 given 18 CPUs and 8 GiB. Node 22.23.4 in the app image, Redis 7.4.12, nginx 1.31.8 with one worker, and k6 2.3.0. Every results directory records its own setup in `setup.json`, with the git commit and the exact command.

### Rerun them

Docker is the only requirement. k6 runs from its image.

```bash
npm run stack:up       # build and start nginx, three instances and Redis on :8080
```

```bash
npm run stack:check    # one client held to one limit across all three instances
```

```bash
npm run bench          # every scenario and algorithm, three runs each
```

```bash
npm run bench -- --scenario edges --algorithm fixed-window --quick   # one cell, short, to bench/results/
```

```bash
npm run bench:analyse -- docs/decisions/data/0008-edges-2026-11-07   # rebuild a summary from saved data
```

```bash
npm run bench:memory   # memory per key; needs the test Redis (npm run redis:up)
```

```bash
npm run stack:down
```

Full runs write to `docs/decisions/data/`, quick runs to `bench/results/`. The raw data behind the tables above: [steady](docs/decisions/data/0008-steady-2026-11-06/), [edges](docs/decisions/data/0008-edges-2026-11-07/), [ramp](docs/decisions/data/0008-ramp-2026-11-07/), [memory](docs/decisions/data/0008-memory-2026-11-06/). CI starts the stack and checks its behaviour on every push, but it compares no numbers, because shared CI machines are too noisy to.

## Design

Each design choice is recorded in [docs/decisions](docs/decisions/README.md), with the alternatives and the evidence: why every algorithm sits behind one async interface, why API keys are hashed, what the reset times mean, and more.

## Development

```bash
npm run lint
npm run typecheck
npm test                  # unit tests, no Redis needed
npm run redis:up          # test Redis in Docker, on port 6390
npm run test:integration
npm run coverage          # unit and integration together
npm run build
examples/basic/demo-check.sh   # two instances on the test Redis, every algorithm
bench/stack-check.sh token-bucket leaky-bucket fixed-window sliding-window-log sliding-window-counter
bench/edges-check.sh           # quick k6 edges runs, as CI does
```

## License

MIT
