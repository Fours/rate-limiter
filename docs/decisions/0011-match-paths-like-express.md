# 0011. Match paths and methods the way Express routes them

- **Status:** Superseded by [0027](0027-match-paths-as-handlers-read-them.md), which also decodes the path and resolves `//`, `.` and `..`, as decoding handlers do. The rules here for case, methods and wildcards still hold.
- **Date:** 2026-11-06
- **Milestone:** 1

## Context

A rule only protects a route if every request that reaches the route also matches the rule. With its default settings, Express 5 routes more loosely than a plain string comparison would match. Under a router mounted at `/api` with `router.get('/orders')`, all of these reach the handler:

| Request | What the middleware sees |
| --- | --- |
| `GET /api/ORDERS` | `baseUrl` `/api`, `path` `/ORDERS` |
| `GET /API/orders` | `baseUrl` `/API`, `path` `/orders` |
| `GET /api/orders/` | `baseUrl` `/api`, `path` `/orders/` |
| `HEAD /api/orders` | method `HEAD`, and the GET handler runs |
| `GET /api` | `baseUrl` `/api`, `path` `/`, so `/api/` when joined |

If the matcher compared strings exactly, a client could get past a `GET /api/orders` limit by changing the case, adding a slash or sending HEAD.

## Decision

- Request paths (`req.baseUrl + req.path`) and rule paths are lower-cased, and one trailing slash is removed unless the path is `/`.
- A `HEAD` request also matches a rule with `method: 'GET'`. Methods are otherwise compared case-insensitively.
- A wildcard such as `/orders/*` matches `/orders` itself and everything under `/orders/`, but not `/ordersXYZ`.
- Tiers are compared exactly, because they come from the app, not the client.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Exact string comparison | Clients can bypass limits with case, a trailing slash or HEAD |
| Read the app's `case sensitive routing` and `strict routing` settings | More code, and it could only ever make matching stricter, which means grouping fewer variants under a rule. Grouping a few extra variants on an app with those settings turned on errs towards limiting, which is the safe side. |
| Match on the route Express picked (`req.route`) | Not known yet when app-level middleware runs, and it ties rules to route definitions instead of URLs |

## Evidence

- `test/rules.test.ts` covers case, trailing slashes, router roots, HEAD and wildcard prefixes with plain request objects.
- `test/rules.express.test.ts` runs the matcher inside a real Express 5 app, mounted both on the app and inside a router, and checks the rule picked for each request in the table above, plus a query string.
- Removing the path normalisation, the HEAD rule or the specificity ranking each makes those tests fail.

## Consequences

Rules can't tell `/Orders` from `/orders`. Apps that really serve different content on paths that differ only by case would have to limit them together. When milestone 2 loads rules from YAML or JSON, the same normalisation applies, so rule files can use any case.
