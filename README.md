# @kylewillett/rate-limiter

Rate-limiting middleware for Express, with pluggable algorithms and standard `RateLimit-*` headers.

> **Status: milestone 1 of 5.** Limits are kept in memory, so they apply per process. Shared limits through Redis, four more algorithms and rules loaded from YAML or JSON come in milestone 2. The package is not on npm yet. See the [project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C) and the [milestone 1 spec](docs/milestone-1.md).

## Install

Once published:

```bash
npm install @kylewillett/rate-limiter express
```

Express 5 is a peer dependency. Node 22 or later is required.

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
| `limit` | positive integer | Requests allowed per window, which is also the burst size |
| `windowMs` | positive integer | Time for a used-up limit to refill completely, in ms |
| `method` | `string`, optional | For example `POST`. Any method when absent. |
| `path` | `string`, optional | Exact, like `/orders`, or a prefix, like `/orders/*`. Any path when absent. |
| `tier` | `string`, optional | Matches the value from `options.tier`. Any tier when absent. |

The default algorithm is a token bucket: requests are refilled steadily, at `limit` per `windowMs`, rather than all at once when a window ends.

Paths and methods match the way Express routes them, so clients can't get around a rule by changing case, adding a trailing slash or sending `HEAD` instead of `GET`. `/orders/*` matches `/orders` itself and anything under it. When several rules match, the most specific wins: exact path, then wildcard path (longest first), then no path; then a rule with `tier` set; then a rule with `method` set; then the one declared first. A request that matches no rule isn't limited and gets no headers. The [spec](docs/milestone-1.md#rule-matching) has the full rules.

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

The demo's code is in [examples/basic/server.ts](examples/basic/server.ts).

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
```

## License

MIT
