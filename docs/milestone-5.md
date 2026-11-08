# Milestone 5: Polish and publish

Source: [Distributed rate limiter: project plan](https://claude.ai/artifact/UKY1bPShdNmagt4Tgftk1C), Milestones → 5, plus "Goals". Scope agreed in a discussion before this spec, on 2026-11-07.

## Outcome

`@kylewillett/rate-limiter` 1.0.0 is on npm, published from CI with provenance, with the rules API settled first: an optional `burst` for the two buckets and an optional `algorithm` per rule. A public demo site lets anyone, technical or not, fire requests at three simulated instances sharing one store and watch the limits trigger. The store runs the exact Lua scripts the package ships, in the browser, and a test against real Redis keeps it honest. The same site carries the design write-up: the 20 decision records turned into one story, with the benchmark and chaos numbers as charts. The portfolio links to it.

**Demo at the end:** open the site on a laptop or a phone. Pick an algorithm and hold the button: requests go round robin to three instances, the headers count down, and 429s appear at the limit, whichever instance answers. Put the fixed window and the sliding window log side by side and send bursts across a window edge: one lets through about twice the limit, the other never goes over. Kill Redis: requests keep being answered by each instance's fallback, and the shared count is lost until it's back. Then read the write-up, which shows the real stack's numbers behind each choice. Finally, `npm install @kylewillett/rate-limiter` and run the README's quick start.

## Scope

In scope:

- An optional `burst` on rules, for the token bucket and the leaky bucket, in memory and in Redis
- An optional `algorithm` on rules, naming one of several algorithms given to the middleware
- An API review for 1.0: TSDoc on every export, a short API reference in the README, a CHANGELOG, package metadata, and checks that the published types and entry points resolve
- A release workflow: GitHub Actions publishes on a version tag, with npm trusted publishing and provenance. Then 1.0.0.
- A static demo site in `demo/`: Vite, React and plain CSS, running the shipped Lua in wasmoon over a Redis stand-in
- The design write-up, as a page on the demo site
- Deploying the site the portfolio's way, on its own subdomain, linked from the portfolio and the README
- Investigating milestone 4's one unexplained edges-check failure in CI

Out of scope:

| Item | Why |
| --- | --- |
| A hosted backend for the demo (a real Redis behind a public endpoint) | Decided against before this spec: a bill, an abuse surface, and a server to keep alive. The real stack's numbers sit next to the demo as recorded evidence instead. |
| Hot-reloading rules | Dropped from the plan's optional items. It conflicts with "invalid configuration throws at startup". |
| A FastAPI port | Dropped from the plan's optional items. A second project, outside the TypeScript stack. |
| A generated TypeDoc site | TSDoc in the code and a README reference are enough for an API this size. |
| Exporting in-memory versions of the four other algorithms | The demo runs the real Lua instead. Not planned. |
| Moving Grafana off port 3001 | A clash on one development machine only. Left as is. |
| Adapters for other frameworks (Fastify, Koa) | Not planned. |

## Design

### `burst`

```yaml
rules:
  - id: orders
    path: /orders
    limit: 100 # per window: the steady rate
    windowMs: 60000
    burst: 10 # at most 10 at once
```

- **What it means.** The steady rate stays `limit` per `windowMs`. `burst` is how many requests can arrive at once from a full bucket. For the token bucket it's the capacity, which today is fixed at `limit`. For the leaky bucket (a GCRA, [0014](decisions/0014-leaky-bucket-as-gcra.md)) it's the tolerance, which today is fixed at one request.
- **Defaults keep today's behaviour:** `limit` for the token bucket and 1 for the leaky bucket. Existing rules and stored state behave exactly as before.
- **Only for algorithms that use it.** A window algorithm has no burst to set, so a rule with `burst` checked by the fixed window, the sliding window log or the sliding window counter throws at startup rather than being silently ignored. An algorithm says it takes one with an optional `supportsBurst?: true` on `Algorithm` (open question 2), which the two buckets set and a caller's own algorithm can set too.
- **Validation:** a positive integer, with the same `2^53` bound as `limit * windowMs` (the token bucket keeps integer units of `burst * windowMs`). Rules files accept it. Bad values throw at startup.
- **In the scripts** it's one more argument (`ARGV[4]`) after the test-only time override. A changed `burst` under a stored key is handled like a changed limit today: whole tokens carry over, never more than the new capacity.
- **The fallback** scales it like the limit: `max(1, ceil(burst / instances))`.
- **Headers:** `RateLimit-Limit` stays `limit`, and `RateLimit-Remaining` counts what can be sent now, at most `burst` ([0022](decisions/0022-burst.md), open question 1).

### `algorithm` per rule

```ts
rateLimit({
  rules, // a rule may say algorithm: 'exact'
  algorithm: counter, // the default, for rules that name none
  algorithms: { exact: log, smooth: leaky }, // the names rules may use
});
```

- **The names are the caller's,** keys of `algorithms`, because rules files are data and algorithms are built objects with clients inside them. A rule naming an algorithm that isn't in `algorithms` throws at startup.
- **Still one interface.** The middleware picks the algorithm for the matched rule and calls `check(key, rule)` on it. Nothing about the middleware bends to one algorithm.
- **Keys don't change.** A rule's ID is unique, so two algorithms never share a key unless the operator moves a rule from one to another, which [0016](decisions/0016-switching-algorithms-starts-fresh.md) already handles: the client starts fresh once.
- **The fallback** is still the one in-memory token bucket for every rule.
- `close()` closes only the algorithms the middleware created, as today: algorithms passed in are the caller's.
- Open question 3 covers the shape.

### 1.0 API review

Every export gets a TSDoc comment, and the README gains a short reference: `rateLimit` and its options, the algorithm factories, the client adapters, rules files, hooks and `prometheusHooks()`. Anything that shouldn't be public after review is removed before 1.0, when removing it is still free. `package.json` gains `description`, `keywords`, `homepage` and `bugs`, and `CHANGELOG.md` starts at 1.0.0. Two development-only tools check the package as npm users will see it: `publint` (package.json and exports) and `@arethetypeswrong/cli` (types for each entry point and module system). Both run in CI after the build.

### Publishing

- `.github/workflows/release.yml` runs on a `v*` tag. It runs the same checks as CI, checks the tag matches `package.json`'s version, and runs `npm publish`. Trusted publishing (OIDC, `id-token: write`) means no npm token is stored anywhere, and npm adds provenance on its own.
- **You do one thing by hand first:** on npmjs.com, add this repository and workflow as the package's trusted publisher. The package must exist for that, so if npm needs it, the very first publish is by hand from your machine. Check that when T4 starts.
- **The first release needs your approval in chat** before the tag is pushed, like any public action.

### The demo

The probe before this spec ran the five shipped scripts in wasmoon (Lua 5.4 in WebAssembly) over a stand-in for the 13 Redis commands they used then (14 since T1 added `HDEL`), and compared them with real Redis: **100,000 checks, no differences** in replies, stored state or expiry, and four deliberate breaks of the stand-in were caught. About 70 to 90 µs a check, and about 150 KB gzipped. Data and the breaks that couldn't show: [0024's probe](decisions/data/0024-wasmoon-probe-2026-11-07/results.md).

- **`demo/`** is a Vite, React and TypeScript app with plain CSS, in this repo. Its dependencies (`vite`, `react`, `wasmoon` and so on) are development dependencies of the root package: none of them ships, since `files` is `["dist"]`.
- **It uses the repo's source, not the published package.** The Lua files aren't a public export, so the demo imports them with Vite's `?raw` and puts the prelude in front the way `loadScript` does. The fallback and the headers come from `src/` too (`createTokenBucket`, `src/headers.ts`), which use no Node modules. The demo copies none of the library's logic.
- **The stand-in** is a typed version of the probe's, in `demo/src/redis/`, with simulated time, so keys expire and the demo can slow time down or pause it. A "kill Redis" switch makes every command fail, which sends checks to the fallback.
- **The parity test** is the probe as an integration test, so the stand-in can't drift from Redis: the same seeded sequences through both, comparing replies, stored state and expiry.
- **The simulation** (round robin over three instances, each with its own fallback, and the timeline of decisions) is pure TypeScript with unit tests. React only draws it.
- **For non-technical visitors first:** plain words on screen, numbers explained where they appear, and the technical detail (headers, keys, the Lua) one click away. It works on a phone and from the keyboard.

### The write-up

A second page on the demo site. It tells the story in the order a reader needs it, not in record order: why limit in the app, keeping instances in step (atomic Lua and Redis time), choosing an algorithm (accuracy against cost), what Redis costs per request, what happens when Redis goes away, and how the numbers were measured. Each claim links to its decision record. Charts are built from `docs/decisions/data/` at build time, so they can't drift from the data. It opens with a short summary a non-engineer can read on its own.

### Deploying

`npm run deploy` the portfolio's way (`/add-s3-deploy`): build `demo/`, sync to `s3://kylewillett.com/<prefix>/`, and invalidate the site's own CloudFront distribution. You create the distribution and the DNS record, and `CLOUDFRONT_DISTRIBUTION_ID` goes in the gitignored `scripts/deploy.config.local`.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T0. The edges-check failure | Done | 8bfc4d2 |
| T1. `burst` | Done | 21c2da5 |
| T2. `algorithm` per rule | Done | 2751a7e |
| T3. API review for 1.0 | Done | |
| T4. Release workflow and 1.0.0 | Not started | |
| T5. Demo foundation | Not started | |
| T6. The demo page | Not started | |
| T7. The write-up | Not started | |
| T8. Deploy and link | Not started | |

### T0. The edges-check failure

Milestone 4's close-out CI run failed `bench/edges-check.sh` once, after 88 s, so not on the 60 s limit. It has passed locally and in CI ever since, and its failures now show as annotations (`cfdd59c`). Read what that run's logs still show, then look for the cause: the fixed window's 1.8× peak check is the likeliest, since it depends on where in the window the bursts land. Write [0021](decisions/0021-per-request-timing-tolerance.md) if the measurement changes.

*As built:* the fixed window wasn't the cause. Pinned to 2 CPUs with a Compose override, the check failed 1 run in 5, and every failure was the sliding window log at 101 against a limit of 100. The fixed window's windows were full on both sides of every edge, even on 2 CPUs. The log was right, and the analysis was too strict. It times requests by arrival, gave each a fixed 2 ms for Redis deciding later (0017), and on a busy machine the limiter's own time varies by more than that. Each request now gets its own tolerance from its `limiterMs`, with 2 ms as the floor ([0021](decisions/0021-per-request-timing-tolerance.md)). Over 20 rounds on 2 CPUs, the old rule read 101 once and the new one never did, and no committed summary or chart changed. `edgeFill` in `bench/analysis.ts` and `bench/edges-report.ts` make the check print how full the windows on each side of every edge got, on every run and in a failure's annotation. A finding on the way: each burst starts 400 to 650 ms before its edge, not 400, because the trickle stops at its first slot past 400. The comment now says so, and the behaviour is kept so 0008's edges data stays comparable. The milestone's planned records moved up one, to 0022 to 0025, and the wasmoon probe's data folder with them.

**Done when:**

- [x] The cause is found and fixed, with a test that fails without the fix, or this section records what was ruled out and how
- [x] `edges-check.sh` passes 10 times in a row locally, and in CI on the task's commit

### T1. `burst`

Write [0022](decisions/0022-burst.md).

*As built:* `supportsBurst` is set by `createTokenBucket`, `createRedisTokenBucket` and `createRedisLeakyBucket`, and `rateLimit` checks every rule against the algorithm at startup. The leaky bucket's tolerance is `(burst − 1) × windowMs` in its 1/limit ms units, with exact integer division for `remaining` and a denial's `resetMs`. When a burst changes under a stored key, the token bucket keeps whole tokens, capped at the new burst. The leaky bucket keeps its schedule, so a raised burst gives the extra room at once (agreed in T1's plan review). The token bucket stores a `burst` field only when it differs from `limit`, and deletes it with `HDEL` when they match again, so state without a burst is byte for byte what it was. That makes the token script's commands 14, which the T5 stand-in needs. `burst` may be larger than `limit`, and the README says `RateLimit-Remaining` can then exceed `RateLimit-Limit`.

**Done when:**

- [x] With `burst` set, the token bucket allows `burst` at once and then `limit` per `windowMs`, in memory and in Redis, tested with `FakeClock`
- [x] With `burst` set, the leaky bucket allows `burst` at once and then one every `windowMs / limit`, tested the same way
- [x] Without `burst`, both behave exactly as before, and state stored before this task still reads correctly
- [x] A changed `burst` under a stored key never grants more than the new capacity
- [x] `burst` on a rule checked by a window algorithm throws at startup, and so do bad values, from code and from rules files
- [x] The fallback scales `burst` by `instances`
- [x] The headers follow the answer to open question 1, tested through supertest
- [x] Break checks: removing the cap on a changed burst, and ignoring `burst` in one script, each fail a test

### T2. `algorithm` per rule

Write [0023](decisions/0023-algorithm-per-rule.md).

*As built:* `rateLimit` resolves each rule to its algorithm once, at startup, and runs the burst check from T1 against that algorithm. Names come only from the `algorithms` object's own keys. Names no rule uses are allowed, rules can't hold algorithm objects, and no name is reserved for the default (agreed in T2's plan review). When only `algorithms` is given, rules that name none use the built-in in-memory token bucket, as before, and `close()` stops it. An unknown name's error lists the names there are.

**Done when:**

- [x] A rule naming an algorithm is checked by it, and a rule naming none by the default, tested with recording fake algorithms
- [x] An unknown name throws at startup, from code and from rules files
- [x] Integration: two rules on two Redis algorithms share one Redis, and each behaves as its algorithm should
- [x] Moving a rule to another algorithm starts its clients fresh, as 0016 says, tested against Redis
- [x] `close()` closes only the algorithms the middleware created
- [x] `burst` validation (T1) uses the rule's own algorithm

### T3. API review for 1.0

*As built:* **Removed from the public API:** `TokenBucket.sweep()` and `TokenBucket.size`, which were there for tests. `createTokenBucket` now returns an object with only `check`, `close` and `supportsBurst`, and tests use the internal `createTokenBucketForTest`. Everything else stays, agreed in T3's plan review: `buildKey` as the key format for tooling, `DEFAULT_BUCKETS` to extend from, and `systemClock`, `defaultIdentify`, `RateLimitTimeoutError` and `IdentifiableRequest`, which pair with options that are already public. `test/package/api.test.ts` reads `dist/`'s `.d.ts` files with the TypeScript compiler API. It checks that each entry point exports exactly a written list, so the API can't change by accident, and that every export has TSDoc. `attw` runs with `--profile esm-only`: the package is ESM only, so `node10` resolution (which ignores `exports`, and fails on `/prometheus`) and `require` from CommonJS don't apply. `scripts/check-pack.js` replaces CI's `grep` checks. It reads `npm pack --dry-run --json`, fails on any file outside `dist/` other than the README, the licence, the changelog and `package.json`, and still requires the Lua scripts, both entry points and `prom-client` as an optional peer dependency. npm doesn't include a changelog on its own, so `files` lists `CHANGELOG.md`. `homepage` is the GitHub README until T8 puts the demo site up. `npm audit` reports 10 moderate advisories, all in ESLint's dependencies and all there before this task. *After T3, from a review for 1.0:* the default `identify` no longer reads `x-api-key`. Any made-up key was a new client with a full limit, so the default limit could be bypassed ([0026](decisions/0026-no-unverified-api-keys.md)). `IdentifiableRequest` loses `headers`. A security review then found, and this fixes: encoded, doubled and dot paths getting past path rules ([0027](decisions/0027-match-paths-as-handlers-read-them.md)); two limiters on one Redis writing each other's keys, fixed by a `prefix` option ([0028](decisions/0028-key-prefix-per-limiter.md)); `timeoutMs` and `sweepIntervalMs` above 2^31 − 1, which Node runs as 1 ms; NAT64 clients sharing one /64, and forged `X-Forwarded-For` values that aren't IPs becoming client IDs ([0029](decisions/0029-ipv4-in-ipv6-and-non-ip-values.md)). A correctness review then found, and this fixes: `..` paths that Express routes into a prefix rule's handlers, but that 0027 resolved to outside it ([0030](decisions/0030-match-dot-dot-both-ways.md)); one malformed escape keeping the whole path encoded, now decoded segment by segment; the sliding window log overwriting an entry when `windowMs` shrank within one millisecond, so every request in it was allowed; the token bucket and the sliding window counter locking out a client whose checks alternate between two rules, as in a rolling deploy ([0031](decisions/0031-two-rules-on-one-key.md)); an ioredis client with `stringNumbers: true` failing every check at request time, now converted in `fromIoredis`; the fallback giving a leaky bucket rule without a burst its whole limit at once; a hook turning a `429` into a `200` by writing to its event, now frozen, as are the rules, copied at startup.

**Done when:**

- [x] Every export from `src/index.ts` and `src/prometheus.ts` has a TSDoc comment, and anything removed from the public API is listed in this section
- [x] The README has an API reference section and the options table covers `burst`, `algorithm` and `algorithms`
- [x] `CHANGELOG.md` has a 1.0.0 entry
- [x] `package.json` has `description`, `keywords`, `homepage` and `bugs`, and its version is 1.0.0
- [x] `publint` and `attw --pack` pass, and run in CI
- [x] `npm pack` contents are checked in CI as today, and nothing outside `dist/`, the README, the licence and the changelog ships

### T4. Release workflow and 1.0.0

Write [0025](decisions/0025-publish-from-ci-with-provenance.md).

**Done when:**

- [ ] `release.yml` publishes on a `v*` tag only after every CI check passes, and refuses a tag that doesn't match the version
- [ ] Trusted publishing is set up on npmjs.com (by you), and the workflow has no npm token
- [ ] After your approval in chat, `v1.0.0` is tagged and published, and npm shows its provenance
- [ ] In an empty folder, installing the published package and running the README's quick start works, on Node 22.23.4 and 24.22.1
- [ ] AGENTS.md and the README no longer say the package is unpublished

### T5. Demo foundation

Write [0024](decisions/0024-demo-runs-the-shipped-lua.md).

**Done when:**

- [ ] `npm run demo:dev` and `npm run demo:build` work, and lint and typecheck cover `demo/`
- [ ] The stand-in has unit tests for each of its 14 commands, including `WRONGTYPE` and expiry on simulated time
- [ ] The parity test runs at least 10,000 checks across the five scripts against the test Redis and finds no differences, and breaking the stand-in makes it fail
- [ ] A built page runs a check in a real browser, so wasmoon's `.wasm` loads through Vite, as a Playwright smoke test (Chromium only) in CI (open question 6)
- [ ] Nothing in `demo/` reaches the npm package, checked by the existing `npm pack` check

### T6. The demo page

**Done when:**

- [ ] The simulation has unit tests: round robin over three instances, a shared limit across them, each instance's own fallback while Redis is killed, and the shared count back once Redis returns
- [ ] A visitor can pick any of the five algorithms, send one request or hold for a stream, and see each response's instance, status and headers
- [ ] The side-by-side view shows the fixed window going over the limit at an edge and the sliding window log not, from the same requests
- [ ] The page works at 375 px wide and from the keyboard
- [ ] Someone non-technical can say what it shows without help (you check this)

### T7. The write-up

**Done when:**

- [ ] The page covers the sections under Design, and every claim links to a decision record
- [ ] Its charts are built from `docs/decisions/data/` at build time, with a test that fails if a source file is missing
- [ ] It opens with a summary a non-engineer can read alone
- [ ] The README links to it, and `docs/decisions/README.md` says it's the public write-up

### T8. Deploy and link

**Done when:**

- [ ] `npm run deploy` builds and publishes the site, set up the portfolio's way
- [ ] The site is live on its subdomain, with both pages and working links
- [ ] The README and the npm page link to the demo, and the portfolio links to it (a commit in the portfolio repo). `homepage` in `package.json` becomes the site.

## Definition of done

- [ ] T0 to T8 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `test:integration` and `build` all pass, locally and in CI, and the CI stack checks pass.
- [ ] Line coverage is still at least 90% for `src/`.
- [ ] Still no runtime dependencies other than the Express peer dependency. `prom-client` is an optional peer dependency.
- [ ] `@kylewillett/rate-limiter` 1.0.0 is on npm with provenance.
- [ ] The demo and the write-up are live and linked from the portfolio.
- [ ] Every results directory in `docs/decisions/data/` has a `setup.json`.

## Decision records

New:

- [0021](decisions/0021-per-request-timing-tolerance.md) (T0): each request's own timing tolerance in the benchmark analysis, from its `limiterMs`, superseding 0017's fixed 2 ms
- [0022](decisions/0022-burst.md) (T1): what `burst` means for each bucket, its defaults, why window algorithms reject it, and the headers
- [0023](decisions/0023-algorithm-per-rule.md) (T2): algorithms named by the caller, chosen per rule, and what moving a rule does
- [0024](decisions/0024-demo-runs-the-shipped-lua.md) (T5): the demo runs the shipped scripts in wasmoon over a stand-in, kept honest by a parity test, rather than a hosted backend or TypeScript copies
- [0025](decisions/0025-publish-from-ci-with-provenance.md) (T4): publishing from CI with trusted publishing and provenance, and 1.0.0 as the first version
- [0026](decisions/0026-no-unverified-api-keys.md) (after T3): the default identity never trusts an unverified API key, superseding 0002
- [0027](decisions/0027-match-paths-as-handlers-read-them.md) (after T3): paths are matched the way decoding handlers read them, superseding 0011
- [0028](decisions/0028-key-prefix-per-limiter.md) (after T3): a key prefix per limiter sharing a Redis
- [0029](decisions/0029-ipv4-in-ipv6-and-non-ip-values.md) (after T3): IPv6 that carries IPv4 counts as IPv4, and values that aren't IPs are never client IDs, superseding 0020
- [0030](decisions/0030-match-dot-dot-both-ways.md) (after T3): a path with `..` is matched both as routed and as resolved, superseding 0027
- [0031](decisions/0031-two-rules-on-one-key.md) (after T3): a rule change keeps a client's progress, even when two rules share a key

## Open questions

1. **Headers with a burst.** With `limit: 100` per minute and `burst: 10`, `RateLimit-Limit` could say 100 (the rate) or 10 (what can be sent at once), and `RateLimit-Remaining` counts against one of them. Recommendation: `Limit` stays `limit`, as the header drafts define it (a quota per window), and `Remaining` is what can be sent now, at most `burst`. Clients that pace themselves on `Remaining` then see the truth.

   *Answer (spec review): `Limit` stays `limit`, and `Remaining` is at most `burst`.*

2. **How an algorithm says it takes a burst.** Options: an optional read-only property on `Algorithm`, such as `supportsBurst?: true`, set by the two buckets; or validating by the factory that built it, which a caller's own algorithm can't join. Recommendation: the optional property. It's additive, so it doesn't change `check`, and a caller's own algorithm can opt in.

   *Answer (spec review): an optional `supportsBurst?: true` on `Algorithm`.*

3. **The shape of per-rule algorithms.** `algorithms: { name: Algorithm }` beside the default `algorithm`, as above, or a factory that builds all five from one client, with fixed names. Recommendation: caller-named, as above. It works for in-memory, Redis and custom algorithms alike. A helper that builds all five can come later without changing it.

   *Answer (spec review): caller-named, as above.*

4. **The subdomain.** For example `ratelimiter.kylewillett.com` or `rate-limiter.kylewillett.com`.

   *Still open. Needed by T8.*

5. **Analytics.** PostHog the portfolio's way (`/add-posthog`), or none. Recommendation: add it, to see whether reviewers reach the write-up.

   *Answer (spec review): PostHog, the portfolio's way.*

6. **Testing the demo in a real browser.** A Playwright smoke test in CI (Chromium only, about 150 MB more per CI run, free on a public repo) or a manual check with each demo change. Recommendation: Playwright, one smoke test, so a broken `.wasm` load fails CI rather than the live site.

   *Answer (spec review): one Playwright smoke test in CI.*

7. **Demo dependencies.** In the root `package.json` as development dependencies, as above, or a separate `demo/package.json`. Recommendation: the root. One install, one lint and typecheck, and the demo imports `src/` directly.

   *Answer (spec review): development dependencies in the root `package.json`.*
