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
- Each key keeps `tokens` and `lastRefillMs`. A new key starts full.
- On each check: `elapsed = max(0, now - lastRefillMs)` (this guards against the clock going backwards), then `tokens = min(limit, tokens + elapsed * rate)`, then `lastRefillMs = max(lastRefillMs, now)`. Keeping the high-water mark matters: with `lastRefillMs = now`, a clock that steps back and then returns would refill the same span twice.
- Implementation: tokens are stored as integer units, `units = tokens * windowMs`, so the bucket holds `limit * windowMs` units, a token costs `windowMs` units, and refill adds `elapsed * limit` units. The formulas below are the same, scaled, and every value is an exact integer. Plain float tokens can land on `0.9999999999999999` after waiting exactly `resetMs` (for example `limit: 48, windowMs: 86_400_000`), which would deny a request the headers said was allowed. This needs `limit * windowMs <= Number.MAX_SAFE_INTEGER`, which rule validation checks.
- If `tokens >= 1`, take one token and allow the request. Otherwise deny it and leave the state as it is.
- `remaining = floor(tokens)` after the take.
- `resetMs`:
  - When allowed, it's the ms until the bucket is full again: `ceil((limit - tokens) / rate)`.
  - When denied, it's the ms until the next token: `ceil((1 - tokens) / rate)`.
- Eviction: a key whose bucket would be full has no information worth keeping. A sweep removes such keys on an interval (default 60 s). The sweep uses an `unref()`'d timer and stops on `close()`, so the map can't grow without bound.

### Rule matching

A rule matches when every field it sets matches the request. Paths and methods match the way Express routes them, so a client can't get past a rule by changing case, adding a slash or sending HEAD ([0011](decisions/0011-match-paths-like-express.md)):

- `method` is compared case-insensitively. A `HEAD` request also matches a `GET` rule, because Express runs GET handlers for HEAD.
- `tier` comes from `opts.tier(req)` and is compared exactly.
- `path` is checked against the request path without the query string (`req.baseUrl + req.path`). Both sides are lower-cased, and one trailing slash is removed unless the path is `/`. A router's root (`/api` + `/`) therefore matches `/api`.
- A wildcard `/orders/*` matches `/orders` itself and anything under `/orders/`, but not `/ordersXYZ`. `/*` matches every path.

When several rules match, the most specific one wins, in this order:

1. An exact `path` beats a wildcard `path`, and a wildcard beats no `path`. Between two wildcards, the longer prefix wins.
2. A rule with `tier` set beats one without.
3. A rule with `method` set beats one without.
4. If it's still a tie, the rule declared first wins.

No match means the request is not limited. `next()` runs and no headers are set.

Rules are checked once, when the middleware is created. Types are checked at runtime too, because milestone 2 loads rules from YAML or JSON:

- `id` is a non-empty string, unique across rules.
- `limit` and `windowMs` are positive integers, with `limit * windowMs <= Number.MAX_SAFE_INTEGER` (the token bucket counts in exact integer units).
- `path`, if set, starts with `/`, has no `?` or `#`, and is either exact or ends in `/*` with no other `*`.
- `method`, if set, is letters only. `tier`, if set, is a non-empty string.

Invalid rules throw an `InvalidRuleError` that names the rule's position and id, at startup, never at request time. An empty list of rules is valid and limits nothing.

### Client identification

The default `identify(req)` uses the first one of these that is present:

1. `x-api-key` header → `key_<first 16 hex chars of sha256(apiKey)>`. The raw key is hashed so it never ends up in storage keys, logs or metric labels.
2. `req.user?.id` → `user_<id>`
3. `req.ip` → `ip_<ip>`
4. Otherwise → `anon`

An empty `x-api-key` header, a `user.id` that is empty or not a string or finite number, and an empty `req.ip` all count as absent. Otherwise a blank value would put every client that sends it into one shared bucket.

You can replace it with `opts.identify`. Behind a load balancer, `req.ip` is only correct when Express `trust proxy` is configured. The README must say so.

The storage key is `rl:{rule.id}:{clientId}`, for example `rl:orders:free:key_3f2a9c1e5b7d4e8a`.

### Middleware

```ts
import { rateLimit } from '@kylewillett/rate-limiter';

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

| Task | Status | Commit |
| --- | --- | --- |
| T0. Scaffold the repo | Done | 02263ad |
| T1. Core types and clock | Done | 3958aea |
| T2. In-memory token bucket | Done | 59389a6 |
| T3. Rule matching | Done | 0d230a2 |
| T4. Client identification and key building | Done | |
| T5. Header helper | Not started | |
| T6. Express middleware | Not started | |
| T7. Example app and README | Not started | |

### T0. Scaffold the repo

- `package.json` with:
  - `"name": "@kylewillett/rate-limiter"` and `"version": "0.1.0"`
  - `"type": "module"` and `"engines": { "node": ">=22" }`
  - `"publishConfig": { "access": "public" }`, so the scoped package publishes as public
  - `"files": ["dist"]`, plus `exports` and `types` pointing into `dist/`
- `.nvmrc`, `.gitignore`, `LICENSE` (MIT)
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

- [x] A new key allows exactly `limit` requests, then denies.
- [x] After a denial, `resetMs` equals the time to one token. Advancing by that much allows exactly one more request.
- [x] Partial refill works, for example half a window gives back half the tokens, floored.
- [x] Tokens never go above `limit` after a long idle period.
- [x] Separate keys and separate rules don't affect each other.
- [x] A clock that goes backwards doesn't add tokens.
- [x] The sweep removes full buckets and keeps partial ones. `close()` stops the timer.
- [x] `remaining` and `resetMs` are integers and never negative.

### T3. Rule matching

`src/rules.ts` exports `validateRules(rules)` and `createMatcher(rules)`, which returns `(req, tier) => Rule | undefined`.

**Done when** tests cover:

- [x] Each validation error
- [x] Exact path, wildcard path, and no path
- [x] Each step of the specificity order, including the declaration-order tie-break
- [x] Case-insensitive method matching
- [x] Ignoring the query string
- [x] Routers mounted with `baseUrl`

### T4. Client identification and key building

`src/identify.ts` exports `defaultIdentify(req)` and `buildKey(rule, clientId)`.

**Done when** tests cover:

- [x] The precedence order (API key, then user, then IP, then anon)
- [x] The raw API key never appearing in the output
- [x] Stable hashing
- [x] The key format

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
- The README covers install, a quick start, the options, the `trust proxy` note, and the header semantics. It also warns that a custom `identify` should return IDs that can't be confused with another rule's keys. Rule ids may contain `:`, so rule `a` with client ID `b:ip_1` and rule `a:b` with `ip_1` both give `rl:a:b:ip_1`. The default IDs always start with `key_`, `user_`, `ip_` or `anon`, so they can only collide like this if a rule id contains a segment such as `:user_`.

**Done when:** the demo described in "Outcome" works from a clean clone.

## Definition of done

- [ ] T0 to T7 are complete.
- [ ] `npm run lint`, `typecheck`, `test` and `build` all pass, locally and in CI.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] No runtime dependencies other than the Express peer dependency.
- [ ] The public API is exported only from `src/index.ts`.

## Decision records

This milestone sets up records [0001](decisions/0001-async-algorithm-interface.md) to [0005](decisions/0005-metrics-through-hooks.md) in `docs/decisions/`. If the design changes during implementation, update the matching record in the same commit.

## Open questions

- Should `RateLimit-Reset` while allowed mean "until full" (as specified here) or "until one more token"? This spec uses "until full" because it matches what clients usually read as "when my quota resets".
- Should a rule allow a burst size separate from `limit`? This spec says no for now, and treats it as a possible milestone 2 change.
- Should IPv6 clients be limited per /64 instead of per address? One client usually controls a whole /64, so per-address limits let it rotate addresses for a fresh limit each time. This spec limits per address for now, and treats grouping as a possible milestone 2 or 4 change. A custom `identify` can group addresses today.
