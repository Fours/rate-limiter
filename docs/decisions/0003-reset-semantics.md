# 0003. What `resetMs` means when allowed vs denied

- **Status:** Accepted, and open to change in milestone 2
- **Date:** 2026-11-06
- **Milestone:** 1

## Context

A token bucket has no single "reset" moment, because it refills continuously. Clients read `RateLimit-Reset` and `Retry-After` to decide when to try again, and they read the two headers differently.

## Decision

- **When allowed:** `resetMs` is the time until the bucket is full again. It goes into `RateLimit-Reset`.
- **When denied:** `resetMs` is the time until the next token. It goes into both `RateLimit-Reset` and `Retry-After`.

Both are rounded up to whole seconds in the headers.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Always the time until the next token | Under steady use `RateLimit-Reset` would sit at about 0, which tells the client nothing about its overall quota |
| Always the time until full | A denied client would wait far longer than it needs to |
| Separate `resetMs` and `retryAfterMs` fields | Clearer, but adds a field every Lua script has to return. Revisit in milestone 2 if the five algorithms disagree on meaning. |

## Evidence

Unit tests check both cases. After a denial, advancing the fake clock by `resetMs` allows exactly one request.

## Consequences

The window algorithms in milestone 2 have to map their own reset times onto these two meanings.
