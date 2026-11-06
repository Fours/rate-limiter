# 0016. Switching algorithms starts each client fresh

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

All five algorithms store a client's state under the same key, `rl:{rule.id}:{clientId}`, as the milestone 1 key format requires. They store it in different shapes: hashes with different fields, or a sorted set for the sliding window log. When an app switches algorithms on a live Redis, which the milestone 2 demo does with one line, the new script finds the old algorithm's state. A probe on Redis 7.4 showed that reading a sorted set with `HMGET` fails with `WRONGTYPE`. Reading another algorithm's hash would misread its fields instead.

## Decision

Every script tags its state with its algorithm name: an `alg` field in a hash, or the equivalent for other types. Before reading, a script checks the key's `TYPE`, and the tag for a hash. If the key holds another type, or a hash without its own tag, the script deletes the key and treats the client as new.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Do nothing | Every request fails with `WRONGTYPE`, or silently misreads state, until the old keys expire. That can be a whole window or longer. |
| Put the algorithm in the key, such as `rl:tb:{rule.id}:{clientId}` | Changes the key format that milestone 1 fixed and the README documents. Old keys would also linger unused until they expire. |
| Ask operators to flush the keys when they switch | Easy to forget, and dangerous on a shared Redis |

## Evidence

- `test/integration/algorithms/token-bucket.test.ts` plants a sorted set, a string, a hash tagged with another algorithm and an untagged hash under a key. Each time, the Redis token bucket treats the client as new, with no `WRONGTYPE` error.
- `test/integration/algorithms/fixed-window.test.ts` switches both ways between the token bucket and the fixed window on a used-up key. Each time the client starts fresh.
- The same file plants a hash tagged as another algorithm but shaped like a used-up fixed window. With the check, the client starts fresh. Without it, the request is denied by state that isn't the fixed window's.
- That last test matters because breaking the check left the real two-way switch tests passing: the token bucket and fixed window store different field names, so neither misreads the other. The check earns its keep when field names overlap, as they will between the token bucket's `window` and the sliding window counter's. Breaking it fails the planted-hash tests in both files.

## Consequences

After a switch, each client gets a fresh limit once, at its first request under the new algorithm. That's a brief overshoot of at most one burst per client, which is acceptable for a deliberate operator action. Every script pays for one extra `TYPE` call per check, which stays inside the same atomic script, so it adds no round trip.
