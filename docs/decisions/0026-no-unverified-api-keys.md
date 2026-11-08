# 0026. The default identity never trusts an unverified API key

- **Status:** Accepted. Supersedes [0002](0002-hash-api-keys.md).
- **Date:** 2026-11-07
- **Milestone:** 5

## Context

`defaultIdentify` took the client from the first of: an `x-api-key` header, `req.user.id`, then the IP. The header was read as sent. The limiter doesn't know which keys are real, so any string identified a client, and every new string was a new client with a full limit.

A client that sent a different made-up key on each request was never limited. A probe against the built package, with one rule of 3 a minute and one client:

| Requests | `x-api-key` | Allowed |
| --- | --- | --- |
| 20 | none | 3 |
| 20 | `fake-0` to `fake-19` | 20 |

So, with the defaults, the IP limit only applied to clients that didn't send the header. Stopping exactly that is the job of a limiter in front of an API. Neither the README nor [0002](0002-hash-api-keys.md) mentioned it: 0002 is about not storing keys, not about trusting them.

The middleware usually runs before an app's auth, so it can't know a key is valid unless something tells it. 1.0 is the last point where changing the default is free.

## Decision

`defaultIdentify` uses `req.user.id`, then the IP, then `anon`. It never reads an API key header. To limit by key, an app checks the key in its auth middleware, sets `req.user` to the account, and mounts the limiter after it, or passes an `identify` that reads its own verified account. The limiter only trusts what the app has already checked.

## Alternatives considered

| Option | Why not |
| --- | --- |
| An opt-in key check, such as `apiKeys: { isValid(key) }`, falling back to the IP for keys it rejects | A synchronous check rarely fits: real keys live in a database. An async one puts a lookup on every request, inside the 50 ms timeout. More API to keep for 1.x, for what one line of auth wiring already does. |
| Limit a request with a key by both the key and the IP | Two checks and two Redis round trips per request, and the middleware bends around one identity scheme, which the one-interface rule rules out ([0001](0001-async-algorithm-interface.md)) |
| Keep the default, and document the risk | The default stays unsafe, and most people never read the warning |

## Evidence

- The probe above, against the built package before the change.
- `test/middleware.test.ts` sends ten requests from one client, each with a new made-up `x-api-key`, against a limit of 2, and expects two `200`s and eight `429`s. Putting the header back in `defaultIdentify` fails it, with ten `200`s, and fails the unit and Express tests in `test/identify.test.ts` and `test/identify.express.test.ts` too.
- `test/identify.express.test.ts` checks that `req.user.id`, set by middleware mounted before the limiter, identifies the client in a real Express app.

## Consequences

- Apps that limited by key without auth must now write one line, or a small auth middleware. A limiter mounted before auth limits by IP only, which is the safe answer for traffic nobody has verified yet.
- No secret goes into a storage key, since an account ID isn't one. [0002](0002-hash-api-keys.md)'s rule, that raw keys never reach storage, logs or metric labels, still holds, and the README and the example keep to it.
- `IdentifiableRequest` no longer has `headers`. An Express `Request` still satisfies it.
- Clients identified by key before get new storage keys, so they start once with a full limit. No version was published, so no one depends on the old keys.
- The benchmarks and the CI stack checks simulate many clients by sending `x-api-key` from one machine. The benchmark app passes its own `benchIdentify`, which reads the header, as is fine in a harness where every client is made up. It keeps the `key_` plus 16 hex characters form, so [0008](0008-sliding-window-accuracy-vs-cost.md)'s memory figures stay comparable.
- The example has a stand-in auth middleware: any key starting `demo-` is an account, any other gets a `401`, and no key means the IP. Its `pro` tier comes from the verified account.
