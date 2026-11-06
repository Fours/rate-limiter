# Milestone 1: Single-process core

Source: [Distributed rate limiter: project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C), Milestones → 1.

## Outcome

An Express app can add one middleware and get per-client rate limiting with an in-memory token bucket. It sets standard rate-limit headers and returns 429 when a client is over the limit. This milestone runs in one process only. Redis comes in milestone 2.

**Demo at the end:** run `examples/basic`, send requests in a loop with curl, and watch `RateLimit-Remaining` count down until a 429 with `Retry-After` comes back.

## Scope

In scope:

- The `Algorithm` interface and the `Decision` result type
- An injectable clock, with a fake clock for tests
- An in-memory token bucket
- Rule matching by path, method and tier, defined in code
- Client identification: API key, then user ID, then IP
- Express middleware that sets headers, returns 429 and otherwise calls `next()`
- Unit and middleware tests, plus a runnable example app

Out of scope (later milestones):

| Item | Milestone |
| --- | --- |
| Redis store, Lua scripts, `EVALSHA` | 2 |
| The other four algorithms | 2 |
| Rules loaded from YAML or JSON | 2 |
| Docker Compose, k6, benchmarks | 3 |
| Timeout, in-memory fallback, `onDecision` and `onFallback` hooks, Prometheus | 4 |
| npm publish, demo page, write-up | 5 |

Design for these without building them. In particular, the `Algorithm` interface must fit a Redis-backed version unchanged.

## Design

### Types

```ts
export interface Rule {
  id: string;          // unique, used in the storage key, e.g. "orders:free"
  limit: number;       // max requests per window (bucket capacity), positive integer
  windowMs: number;    // time to refill a full bucket, positive integer
  method?: string;     // e.g. "POST"; matches any method when absent
  path?: string;       // exact "/orders" or prefix "/orders/*"; any path when absent
  tier?: string;       // e.g. "free"; matches any tier when absent
}

export interface Decision {
  allowed: boolean;
  remaining: number;   // whole requests left right now, >= 0
  resetMs: number;     // see "Token bucket" below
}

export interface Algorithm {
  check(key: string, rule: Rule): Promise<Decision>;
}

export interface Clock {
  now(): number;       // epoch ms
}
```

`check` returns a Promise even for the in-memory version, so the Redis version in milestone 2 plugs in without changing the middleware. Any store or clock is passed in when the algorithm is built, never through `check`.

### Token bucket

- Capacity is `rule.limit`. The refill rate is `limit / windowMs` tokens per ms.
- Each key keeps `tokens` (a float) and `lastRefillMs`. A new key starts full.
- On each check: `elapsed = max(0, now - lastRefillMs)` (this guards against the clock going backwards), then `tokens = min(limit, tokens + elapsed * rate)`, then `lastRefillMs = now`.
- If `tokens >= 1`, take one token and allow the request. Otherwise deny it and leave the state as it is.
- `remaining = floor(tokens)` after the take.
- `resetMs`:
  - When allowed, it's the ms until the bucket is full again: `ceil((limit - tokens) / rate)`.
  - When denied, it's the ms until the next token: `ceil((1 - tokens) / rate)`.
- Eviction: a key whose bucket would be full has no information worth keeping. A sweep removes such keys on an interval (default 60 s). The sweep uses an `unref()`'d timer and stops on `close()`, so the map can't grow without bound.

### Rule matching

A rule matches when every field it sets matches the request:

- `method` is compared case-insensitively.
- `tier` comes from `opts.tier(req)`.
- `path` is checked against the request path without the query string (`req.baseUrl + req.path`).

When several rules match, the most specific one wins, in this order:

1. An exact `path` beats a wildcard `path`, and a wildcard beats no `path`. Between two wildcards, the longer prefix wins.
2. A rule with `tier` set beats one without.
3. A rule with `method` set beats one without.
4. If it's still a tie, the rule declared first wins.

No match means the request is not limited. `next()` runs and no headers are set.

Rules are checked once, when the middleware is created: ids must be unique, `limit` and `windowMs` must be positive integers, and `path` must be either exact or end in `/*`. Invalid rules throw at startup, never at request time.

### Client identification

The default `identify(req)` uses the first one of these that is present:

1. `x-api-key` header → `key_<first 16 hex chars of sha256(apiKey)>`. The raw key is hashed so it never ends up in storage keys, logs or metric labels.
2. `req.user?.id` → `user_<id>`
3. `req.ip` → `ip_<ip>`
4. Otherwise → `anon`

You can replace it with `opts.identify`. Behind a load balancer, `req.ip` is only correct when Express `trust proxy` is configured. The README must say so.

The storage key is `rl:{rule.id}:{clientId}`, for example `rl:orders:free:key_3f2a9c1e5b7d4e8a`.

### Middleware

```ts
rateLimit({
  rules: Rule[],
  algorithm?: Algorithm,            // default: in-memory token bucket
  identify?: (req) => string,
  tier?: (req) => string | undefined,
}): RequestHandler & { close(): void }
```

For each request:

1. Match the rule. If none matches, call `next()` and stop.
2. Build the key and `await algorithm.check(key, rule)`.
3. Always set these headers:
   - `RateLimit-Limit: <rule.limit>`
   - `RateLimit-Remaining: <remaining>`
   - `RateLimit-Reset: <ceil(resetMs / 1000)>` (seconds)
4. If the request is allowed, call `next()`.
5. If it's denied, set `Retry-After: <ceil(resetMs / 1000)>` and respond `429 { "error": "rate_limited" }`. The route handler never runs.
6. If `check` throws, call `next(err)`. Milestone 4 replaces this with the fallback.

Express 5 is a peer dependency.

## Tasks

Do these in order. Each one ends with passing tests.

### T0. Scaffold the repo

- `package.json` (ESM, `"engines": { "node": ">=22" }`), `.nvmrc`, `.gitignore`, `LICENSE` (MIT)
- TypeScript strict config, built with `tsc` to `dist/` with type declarations
- Vitest with coverage, ESLint and Prettier
- Scripts: `build`, `typecheck`, `lint`, `format`, `test`, `test:watch`, `coverage`
- GitHub Actions workflow that runs lint, typecheck and test on push and PR

**Done when:** `npm run lint && npm run typecheck && npm test` passes on an empty test suite, locally and in CI.

### T1. Core types and clock

- `src/types.ts` with `Rule`, `Decision`, `Algorithm` and `Clock`
- `src/clock.ts` with `systemClock`
- `test/helpers/fake-clock.ts` with `FakeClock` (`now()`, `advance(ms)`, `set(ms)`)

**Done when:** the types compile, and `FakeClock` has tests.

### T2. In-memory token bucket

`src/algorithms/token-bucket.ts` exports `createTokenBucket({ clock?, sweepIntervalMs? })`, which returns an `Algorithm & { close() }`.

**Done when** tests with `FakeClock` cover:

- [ ] A new key allows exactly `limit` requests, then denies.
- [ ] After a denial, `resetMs` equals the time to one token. Advancing by that much allows exactly one more request.
- [ ] Partial refill works, for example half a window gives back half the tokens, floored.
- [ ] Tokens never go above `limit` after a long idle period.
- [ ] Separate keys and separate rules don't affect each other.
- [ ] A clock that goes backwards doesn't add tokens.
- [ ] The sweep removes full buckets and keeps partial ones. `close()` stops the timer.
- [ ] `remaining` and `resetMs` are integers and never negative.

### T3. Rule matching

`src/rules.ts` exports `validateRules(rules)` and `createMatcher(rules)`, which returns `(req, tier) => Rule | undefined`.

**Done when** tests cover:

- [ ] Each validation error
- [ ] Exact path, wildcard path, and no path
- [ ] Each step of the specificity order, including the declaration-order tie-break
- [ ] Case-insensitive method matching
- [ ] Ignoring the query string
- [ ] Routers mounted with `baseUrl`

### T4. Client identification and key building

`src/identify.ts` exports `defaultIdentify(req)` and `buildKey(rule, clientId)`.

**Done when** tests cover:

- [ ] The precedence order (API key, then user, then IP, then anon)
- [ ] The raw API key never appearing in the output
- [ ] Stable hashing
- [ ] The key format

### T5. Header helper

`src/headers.ts` exports `rateLimitHeaders(rule, decision)` and `retryAfter(decision)`.

**Done when** tests check the second rounding (ceil), including `resetMs` of 0 and of 1.

### T6. Express middleware

`src/middleware.ts` exports `rateLimit(opts)`, and `src/index.ts` is the public entry point.

**Done when** supertest tests cover:

- [ ] Headers on allowed and denied responses
- [ ] The 429 body
- [ ] `Retry-After`
- [ ] The handler not running when the request is denied
- [ ] Requests with no matching rule passing through with no headers
- [ ] A custom `identify` and a custom `tier`
- [ ] `trust proxy` making `X-Forwarded-For` change the identity
- [ ] `next(err)` when the algorithm throws
- [ ] 50 concurrent requests against `limit: 10` giving exactly 10 allowed

### T7. Example app and README

- `examples/basic/server.ts` sets up two rules (a global per-IP rule and a stricter `POST /orders` rule for the free tier).
- `examples/basic/hammer.sh` sends N requests and prints the status and headers for each.
- `npm run example` starts the server.
- The README covers install, a quick start, the options, the `trust proxy` note, and the header semantics.

**Done when:** the demo described in "Outcome" works from a clean clone.

## Definition of done

- [ ] T0 to T7 are complete.
- [ ] `npm run lint`, `typecheck`, `test` and `build` all pass, locally and in CI.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] No runtime dependencies other than the Express peer dependency.
- [ ] The public API is exported only from `src/index.ts`.

## Open questions

- Package name on npm (needed before milestone 5, and nice to have for the README now).
- Should `RateLimit-Reset` while allowed mean "until full" (as specified here) or "until one more token"? This spec uses "until full" because it matches what clients usually read as "when my quota resets".
- Should a rule allow a burst size separate from `limit`? This spec says no for now, and treats it as a possible milestone 2 change.
