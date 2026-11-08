# Changelog

This project follows [Semantic Versioning](https://semver.org/). Each design choice behind these entries has a record in [docs/decisions](https://github.com/Fours/rate-limiter/tree/main/docs/decisions).

## 1.0.0 (unreleased)

The first published version.

### The middleware

- `rateLimit(options)`: Express 5 middleware that limits each client per rule, with a `close()` for shutdown. Invalid options throw at startup, never during a request.
- Rules match by method, path (exact or `/prefix/*`, matched the way Express routes) and tier. The most specific rule wins.
- `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every limited request, and `Retry-After` with a `429` and `{ "error": "rate_limited" }` on a denial. All in whole seconds, rounded up.
- Clients are identified by API key (hashed with sha256, never stored raw), then `req.user.id`, then IP, with IPv6 grouped by /64. `identify` and `tier` options replace or extend this.

### Algorithms

- Five algorithms behind one interface, `check(key, rule): Promise<Decision>`: the token bucket in memory (the default) and in Redis, plus the leaky bucket (as a GCRA), fixed window, sliding window log and sliding window counter in Redis.
- `burst` on a rule, for the token bucket and the leaky bucket: how many requests can arrive at once, apart from the steady rate. A window algorithm given a rule with `burst` throws at startup.
- `algorithm` on a rule, naming one of the `algorithms` given to `rateLimit`, so rules in one limiter can use different algorithms.
- Your own algorithm works too: anything with `check`, and an optional `supportsBurst: true`.

### Redis

- Many instances share one limit through one Redis. Each check is a single atomic Lua script run with `EVALSHA`, using Redis's own time. Redis 7 or later.
- Bring your own client, through `fromIoredis` or `fromNodeRedis`, or anything with `evalsha` and `eval`.
- Each check gets `timeoutMs` (50 ms by default). If Redis fails or is slow, an in-memory token bucket answers instead, splitting the limit across `fallback.instances`. `fallback: false` fails closed.

### Configuration, hooks and metrics

- `loadRules(path)` and `parseRules(text, format)` read rules from JSON or YAML (with the optional `yaml` peer dependency), rejecting unknown fields.
- `onDecision` and `onFallback` hooks, which can never fail a request.
- `prometheusHooks()` from `@kylewillett/rate-limiter/prometheus`, with `prom-client` as an optional peer dependency. The main entry point never loads it.

### Removed before 1.0

No earlier version was published, so nothing depends on these.

- `TokenBucket` no longer has `sweep()` or `size`, which were there for tests. It has `check`, `close` and `supportsBurst`.
