# 0012. Three `RateLimit-*` headers, in seconds from now, and `Retry-After` of at least 1

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 1

## Context

Clients need to know their limit, what's left, and when to try again. There is no single standard for this. Older APIs send `X-RateLimit-*` headers, often with `Reset` as an epoch timestamp. Early drafts of the IETF `httpapi-ratelimit-headers` work defined three headers, `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Later drafts replaced them with one structured `RateLimit` field plus `RateLimit-Policy`. `Retry-After` (RFC 9110) is the one header every HTTP client already understands on a 429.

[0003](0003-reset-semantics.md) defines what `resetMs` means. This record covers how it, and the rest of a `Decision`, is written to the response.

## Decision

- Every limited request gets `RateLimit-Limit` (the rule's `limit`), `RateLimit-Remaining` (the decision's `remaining`) and `RateLimit-Reset`.
- `RateLimit-Reset` and `Retry-After` are seconds from now, as integers, rounded up from `resetMs`. Rounding up means a client that waits the advertised time is never early.
- A denied request also gets `Retry-After`, which is never below 1. `RateLimit-Reset` may be 0, because on an allowed request that correctly means the quota is already full.
- Milliseconds are converted to seconds only in `src/headers.ts`. Everything before that stays in integer milliseconds.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `X-RateLimit-*` headers | The `X-` prefix is deprecated (RFC 6648), and there is no agreed meaning for their values |
| The newer combined `RateLimit` and `RateLimit-Policy` fields | Still an Internet-Draft that has changed shape between versions. Fewer clients and libraries read it today than the three-header form. It can be added later as an option without changing `Decision`. |
| `Reset` as an epoch timestamp | Depends on the client's clock agreeing with the server's. Seconds from now don't. |
| Rounding to the nearest second, or down | A client could retry up to a second early and be denied again |
| Allowing `Retry-After: 0` | Tells a denied client to retry at once. The token bucket never returns `resetMs` of 0 when it denies, but the window algorithms in milestone 2 could at a window boundary. A client that obeys 0 in a loop would hammer the server. |

## Evidence

- `test/headers.test.ts` checks the three header names and string values, rounding up at 0, 1, 999, 1000, 1001 and 60 000 ms, and that `Retry-After` is 1 when `resetMs` is 0. Using floor or round instead of ceil, dropping the conversion to seconds, or removing the lower limit of 1 each makes a test fail.
- A probe of Express 5 showed that `res.set` keeps header-name casing and writes numbers unrounded (`1.5` goes out as `Retry-After: 1.5`), so the helper has to do the rounding.
- The T6 middleware tests check the headers on the wire through supertest.

## Consequences

Clients that read `express-rate-limit`-style headers work unchanged. Rounding up means `Retry-After` can overstate the wait by up to a second, which matters little at the window sizes this library targets. Supporting the newer IETF format later means adding an option in `src/headers.ts`, not a change to the algorithms.
