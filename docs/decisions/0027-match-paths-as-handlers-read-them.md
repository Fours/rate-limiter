# 0027. Match paths the way a decoding handler reads them

- **Status:** Accepted. Supersedes [0011](0011-match-paths-like-express.md).
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

[0011](0011-match-paths-like-express.md) made the matcher follow Express's routing: case-insensitive, with one trailing slash ignored, and HEAD covered by GET. That holds for routes Express matches literally. But some handlers decode or tidy the path before they use it, and serve the same resource for spellings Express's own routing would treat as different.

The 1.0 security review found that, with a rule `{ path: '/downloads/*', limit: 1 }` in front of `express.static`, every one of these served the file with no limit, every time, after the plain path was limited:

| Request | Status | `RateLimit-Limit` |
| --- | --- | --- |
| `/downloads/big.zip` | 429 | 1 |
| `/%64ownloads/big.zip` | 200 | none |
| `/downloads%2fbig.zip` | 200 | none |
| `//downloads/big.zip` | 200 | none |
| `/./downloads/big.zip` | 200 | none |
| `/x/../downloads/big.zip` | 200 | none |
| `/%2e/downloads/big.zip` | 200 | none |

A route with a parameter does the same: under `app.use('/t/:tenant', router)`, `/t/%61cme/report` reached tenant `acme` and missed a `/t/acme/*` rule. Express decodes parameters, but the matcher compared the raw path.

## Decision

The matcher keeps 0011's rules for methods, wildcards and tiers. Before comparing, it reads a path, from the request or from a rule, the way a decoding handler would:

1. Decode percent-escapes once, `%2F` included. A malformed escape is left as it is.
2. Split on `/`, drop empty and `.` segments, and resolve `..`. Above the root, `..` stays at the root.
3. Lower-case.

That covers 0011's trailing slash, and now any number of them. Each step can only make more requests match a rule, never fewer, which errs towards limiting, as 0011 already preferred.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep 0011, and tell apps to mount the limiter only on literal routes | The bypass works against `express.static` and parameter routes, the most common handlers. A rule silently not applying is the failure the matcher exists to prevent. |
| Reject requests with encoded or dot segments | It isn't the limiter's place to refuse requests a handler would serve, and it would break apps with legitimately encoded paths |
| Decode repeatedly until the path stops changing | Handlers decode once, so `%252e` is a file named `%2e`, not `.`. Decoding twice would group requests for different resources under one rule. |
| `path.posix.normalize` | It needs `node:path`. The hand-written loop is a few lines, keeps `src/rules.ts` free of Node modules, and handles `..` above the root the same way. |

## Evidence

- `test/rules.express.test.ts` mounts the limiter in front of a real `express.static`, uses up the plain path's limit, and checks that each spelling above now gets a `429`. A second test checks that `express.static` really serves the file for those spellings, so the first is a real bypass when unlimited. A third covers the parameter route.
- `test/rules.test.ts` covers each spelling with plain request objects, decoding once only, a malformed escape, `..` above the root, and wildcard prefixes.
- Break checks: the old `normalisePath` fails 18 tests. Removing only the decoding fails 10, and treating `..` as an ordinary segment fails 6.

## Consequences

- Rules can't tell `/a%2Fb` from `/a/b`, or `/x/../y` from `/y`. An app that serves different resources on such paths limits them together.
- A rule's own path is normalised the same way, so `/downloads/./*` and `/downloads/*` are the same rule.
- Matching does a little more work per request: one `decodeURIComponent` and a split. That's small next to a Redis round trip.
