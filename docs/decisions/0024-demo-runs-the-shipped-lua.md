# 0024. The demo runs the shipped Lua in wasmoon, over a stand-in kept honest by a parity test

- **Status:** Accepted
- **Date:** 2026-11-09
- **Milestone:** 5

## Context

The public demo should let anyone fire requests at three instances that share one limit, and watch the limits trigger. The limits live in five Lua scripts that run inside Redis. A demo that shows something other than those scripts would be showing a different rate limiter: the fixed window's double burst at an edge, or the sliding window log never going over, are properties of the scripts, and the point is that a visitor sees the real ones. A hosted backend with a real Redis was ruled out before the spec: it costs money, it's an abuse surface, and it's a server to keep alive.

## Decision

- **The browser runs the exact scripts the package ships.** `demo/src/redis/scripts.ts` imports `prelude.lua` and the five algorithm files from `src/` as text (Vite's `?raw`) and joins them the way `loadScript` does. A unit test checks each joined script and its SHA-1 against `loadScript`'s.
- **They run in [wasmoon](https://github.com/ceifa/wasmoon)** (Lua 5.4 compiled to WebAssembly, MIT), with `redis.call` wired to a stand-in. Redis embeds Lua 5.1. The scripts already avoid the two differences that could show, number formatting and integer division, and the parity test would catch them if they didn't.
- **The stand-in** (`demo/src/redis/stand-in.ts`) implements the 14 commands the scripts call, as Redis 7 does: values stored as strings, numbers formatted the shortest way that round-trips, sorted-set ties ordered by member, `WRONGTYPE`, and lazy expiry. Time is simulated, so the demo can slow it down or pause it, and `TIME` and expiry read it. It has a switch that takes it down: every command fails, so checks go to each instance's fallback. Coming back is a restart: the data stays, the script cache empties.
- **The library's own wrapper runs the checks.** The stand-in is a `RedisScriptClient`: `EVALSHA` finds only scripts `EVAL` cached, and rejects with `NOSCRIPT` otherwise. The five algorithms are built with `createRedisAlgorithm`, so each check goes through the same `runScript` (with its `NOSCRIPT` retry) and `parseDecision` as in production. For that, `factory.ts` and `redis/scripts.ts` no longer import Node modules: reading the Lua and hashing it moved to `load-script.ts`, and `test/browser-safe.test.ts` keeps the browser's modules free of Node built-ins. SHA-1s come from Web Crypto in the browser.
- **The `.wasm` is served by the site.** wasmoon fetches it from a CDN in a browser unless given a URL, so the demo passes Vite's asset URL. The Playwright smoke test blocks every other origin and fails if anything tries one.
- **A parity test keeps the stand-in honest.** `test/integration/demo-parity.test.ts` runs the same generated histories through the stand-in and a real Redis, and compares every reply, the key's whole stored state after each check, and the expiry the script set. It's a fast-check property, so a difference shrinks to a short history and prints a seed.
- **The demo's dependencies are development dependencies** of the root package. `files` is `["dist"]`, and `scripts/check-pack.js` fails on anything outside it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A hosted backend: the real stack behind a public endpoint | Decided against before the spec: a bill, an abuse surface, and a server to keep alive. |
| Rewrite the five algorithms in TypeScript for the browser | A second implementation, which could drift from the scripts and would show a visitor the copy, not the package. |
| Fengari (Lua 5.3 reimplemented in JavaScript) | A reimplementation rather than the reference Lua, and interpreted in JS. wasmoon is the reference Lua compiled, and fast enough: 70 to 90 µs a check in the probe. |
| A whole Redis compiled to WebAssembly | Far more to download and keep working than the 14 commands the scripts use, and no build of one was found to rely on. |
| Wrap the scripts in the demo instead of reusing `createRedisAlgorithm` | It would copy `runScript`'s retry and `parseDecision`. Splitting the Node-only parts out of `src/` cost one small module and changes no behaviour. |
| The probe's scripts as they were, run by hand | Nothing would keep the stand-in in step when a script changes. The parity test runs in CI with the integration tests. |

## Evidence

**The probe** before the spec ran 100,000 checks through wasmoon and the stand-in against Redis 7.4.12 with no differences, and four of six deliberate breaks of the stand-in were caught. The other two couldn't show with the scripts as they are. Setup, data and the breaks: [results](data/0024-wasmoon-probe-2026-11-07/results.md).

**The parity test**, from T5, on an Apple M5 Pro with Node 25.8.2, Redis 7.4.12 (`redis:7-alpine` on port 6390) and wasmoon 1.16.0, with `npm run test:integration`:

- 50 generated histories per algorithm, of 40 to 60 checks each, so about 12,500 checks a run, and it fails below 10,000. About 4 seconds. Histories include `burst` on the two buckets, a rule changing under a key, another algorithm checking the key (0016), several checks in one millisecond, checks exactly on window edges and one interval apart, and the clock stepping back.
- **No differences.** An error from a script on either side also counts as a difference, so two failures can't agree and hide what comes after.
- Deliberate breaks, each on its own:

| Break | Result |
| --- | --- |
| Numbers written the Lua 5.4 way (`"1.0"`) | All five algorithms fail |
| Sorted-set ties ordered by member backwards | Fails for every algorithm, since each history can hand its key to the log or the counter |
| Replies not truncated to integers | Unobservable now: since T3 every script replies with whole numbers, so truncating changes nothing. The runner's unit test pins it (`1.9` replies `1`). |
| The 10,000-check floor raised to 100,000 | The count check fails |

**In a browser**, `e2e/demo.spec.ts` (Playwright, Chromium) loads the built site from `vite preview`, waits for the `.wasm`, runs six checks through the token bucket script, and sees five allowed and the sixth limited, with no request to another origin and no page error. Removing the `.wasm` URL makes wasmoon try the CDN, and the test fails.

**Size:** the built site is 114 KB of JavaScript and 112 KB of `.wasm`, gzipped, for the T5 page.

## Consequences

- Every script change is checked against the stand-in by the parity test, so a script using a new Redis command fails it until the stand-in implements that command, with a test of its own.
- The demo shows what the package does, down to its quirks, and its numbers in the write-up can say so.
- The demo's checks take Redis's place in time, not in latency: they cost microseconds in the browser, so the demo can't show what Redis costs per request. The write-up shows the real stack's measurements for that ([0008](0008-sliding-window-accuracy-vs-cost.md), [0009](0009-latency-budget-prefetch.md)).
- `src/algorithms/redis/factory.ts`, `src/redis/scripts.ts`, `src/redis/client.ts`, `src/algorithms/token-bucket.ts` and `src/headers.ts` must stay free of Node built-ins, which `test/browser-safe.test.ts` checks.
- Vite warns at build time that wasmoon's Node-only branches import `module` and `url`. They never run in a browser, as the smoke test shows.
