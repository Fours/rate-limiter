# 0030. Match a path with `..` both as routed and as resolved

- **Status:** Accepted. Supersedes [0027](0027-match-paths-as-handlers-read-them.md).
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

[0027](0027-match-paths-as-handlers-read-them.md) resolves `..` before matching, because `express.static` serves `/x/../downloads/f` as `/downloads/f`. It also says each step "can only make more requests match a rule, never fewer". For `..` that isn't true. Express's own routing and mounts never resolve `..`: `app.get('/admin/:name')` takes `/admin/..` with `name` set to `..`, and `app.use('/admin', …)` takes `/admin/x/../../y`. Resolved, those paths are `/` and `/y`, outside a `/admin/*` rule.

The 1.0 correctness review limited `/admin/*` to 1 and, after `/admin/first`, sent these to an app with both handlers. Each reached an admin handler with a 200 and no `RateLimit-*` headers, every time:

| Request | Handler | Resolved by 0027 to |
| --- | --- | --- |
| `/admin/..` | `/admin/:name`, `name` = `..` | `/` |
| `/admin/%2E%2E` | `/admin/:name`, `name` = `..` | `/` |
| `/admin/..%2Fx` | `/admin/:name`, `name` = `../x` | `/x` |
| `/admin/x/../../y` | the `/admin` mount | `/y` |

Before 0027, all four were limited, so this was a regression in the fix that closed the `express.static` bypass.

## Decision

The matcher reads a request's path two ways, each decoded once, lower-cased, and with empty and `.` segments dropped, as in 0027:

- **as routed:** `..` kept as an ordinary segment, the way Express's routes and mounts see it
- **as resolved:** `..` resolved, the way `express.static` serves it

A rule applies if it matches either reading, and the most specific such rule wins, as usual. A rule's own path is read resolved, as in 0027. Everything else in 0027 holds.

Each reading only adds matches to the other, so the guarantee 0027 meant to give holds now: a request only ever matches more rules than a literal comparison would.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Go back to not resolving `..` | Reopens 0027's `express.static` bypass, `/x/../downloads/big.zip` |
| Apply every rule either reading matches, not just the most specific | One rule per request is how matching works everywhere else (0011). Within a reading, the most specific rule still wins. |
| Refuse requests with `..` segments | It isn't the limiter's place to refuse requests a handler would serve |

## Evidence

- `test/rules.express.test.ts` mounts the limiter in front of `app.get('/admin/:name')` and `app.use('/admin')`, uses up the limit, and checks that each spelling above gets a `429`. A second test checks that each spelling reaches an admin handler when unlimited, so the first is a real bypass.
- `test/rules.test.ts` covers the routing reading with plain request objects, and the most specific rule winning across the two readings.
- 0027's `express.static` tests still pass.
- Break checks: matching only the resolved reading fails 10 tests, and only the routed reading fails 6.

## Consequences

- `/downloads/../other` now matches `/downloads/*`, as a `/downloads` mount would take it.
- A request whose readings fall under different rules gets the more specific one only. `/x/../downloads/f`, under `/x/*` and `/downloads/*`, is limited by `/downloads/*`.
- Matching costs a second comparison per rule, which is small next to a Redis round trip.
