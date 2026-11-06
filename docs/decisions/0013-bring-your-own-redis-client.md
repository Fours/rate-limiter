# 0013. The caller brings their own Redis client

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

The Redis algorithms need to run Lua scripts. Apps that use Redis already have a client, configured with their own connection, TLS, auth, retry and pooling settings. AGENTS.md rules out runtime dependencies unless a milestone spec calls for one, and two popular clients, `ioredis` and `node-redis`, have different APIs.

## Decision

The library defines a two-method interface and takes any client that fits it:

```ts
export interface RedisScriptClient {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}
```

`fromIoredis(client)` and `fromNodeRedis(client)` adapt the two common clients. Their parameter types are structural, listing only the methods the adapters call, so neither library is imported at runtime. Both are dev dependencies, used to test the adapters against a real Redis.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Depend on `ioredis` and create the client inside the library | A runtime dependency, a second connection pool per app, and a second place to configure TLS and auth |
| Accept a connection URL | Same problems, plus the library would own reconnects and shutdown |
| An optional peer dependency on one client | Users of the other client would still need an adapter, and the types would tie the library to one client's versions |
| Only the interface, no adapters | Every user writes the same few lines, and gets argument order wrong in different ways |

## Evidence

- `test/integration/scripts.test.ts` runs the same scripts through `fromIoredis` and `fromNodeRedis` against Redis 7: keys and arguments arrive in order, `EVALSHA` is used when the script is cached, a `SCRIPT FLUSH` leads to exactly one `EVAL`, and script errors pass through without a retry.
- The real `ioredis` `Redis` class and the `node-redis` client typecheck against `IoredisLike` and `NodeRedisLike`, so the structural types fit without importing either library.
- `test/redis/client.test.ts` shows each adapter rejects the other library's client at startup, with a message naming the right adapter.
- `package.json` has no `dependencies`. `ioredis` and `redis` are dev dependencies only, and nothing in `dist/` imports either one.

## Consequences

The library never opens or closes a Redis connection, so the app controls shutdown. Support for another client is one small adapter, or the app can implement the interface itself. The adapters depend on two methods of each client staying stable, which the integration tests watch.
