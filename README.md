# @kylewillett/rate-limiter

Rate-limiting middleware for Express, with pluggable algorithms and standard `RateLimit-*` headers.

> **Status: milestone 2 of 5.** Limits can be shared by many app instances through one Redis, with five algorithms and rules loaded from YAML or JSON. Timeouts and an in-memory fallback for when Redis is down come in milestone 4. The package is not on npm yet. See the [project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C) and the [milestone 2 spec](docs/milestone-2.md).

## Install

Once published:

```bash
npm install @kylewillett/rate-limiter express
```

Express 5 is a peer dependency. Node 22 or later is required.

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

If Redis is unreachable, the check fails once your client stops retrying, and the request goes to Express's error handler. A timeout and an in-memory fallback come in milestone 4.

## Choosing an algorithm

All five use the same rules and headers. They differ in how a client's requests are spread over time:

| Algorithm | Create it with | A client can send | Good for |
| --- | --- | --- | --- |
| Token bucket | `createTokenBucket()` (memory, the default) or `createRedisTokenBucket()` | Up to `limit` at once, then refills steadily at `limit` per `windowMs` | Most APIs: short bursts are fine, the average rate is capped |
| Leaky bucket | `createRedisLeakyBucket()` | One request every `windowMs / limit`, with no burst | Smoothing traffic to a steady rate, for example in front of a fragile backend ([0014](docs/decisions/0014-leaky-bucket-as-gcra.md)) |
| Fixed window | `createRedisFixedWindow()` | `limit` per window, with windows starting on the clock (each minute, for a 60 s window) | The cheapest option, and easy to explain. A client can send up to 2× `limit` across a window boundary. |
| Sliding window log | `createRedisSlidingWindowLog()` | Exactly `limit` in any `windowMs`, measured back from now | Exact limits. Stores one entry per allowed request, so it costs the most memory. |
| Sliding window counter | `createRedisSlidingWindowCounter()` | About `limit` in any `windowMs`, estimated from two counts. It never allows more than `limit` by its estimate. | Close to exact at a fixed, small cost: a good default for Redis |

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
3. `req.ip`, as `ip_<ip>`
4. Otherwise `anon`

Empty values are skipped, so a blank header doesn't put every client in one bucket.

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
```

## License

MIT
