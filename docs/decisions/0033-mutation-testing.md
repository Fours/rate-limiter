# 0033. Mutation testing, with Stryker for the TypeScript and a mutator of our own for the Lua

- **Status:** Accepted
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

Line coverage on `src/` was 99.8%, but coverage only shows that a line ran, not that a test would notice it being wrong. AGENTS.md already asks for break checks: break a key behaviour by hand and see a test fail. Those only cover the lines someone thinks to break. Mutation testing does it for every line. A tool makes one small change at a time, such as `<` to `<=`, `+` to `-`, or a deleted call, runs the tests, and reports each change, or *mutant*, that no test noticed.

Stryker, the usual tool for JavaScript, can't mutate Lua. The five scripts hold most of the algorithms' logic, and the 1.0 correctness review found three of its five Redis bugs in them.

## Decision

- **`npm run mutate` runs [Stryker](https://stryker-mutator.io/) on `src/`,** with the Vitest runner and `vitest.stryker.config.ts`: the unit and integration projects, so the Redis adapters and script runner count too. It runs only the tests that cover each mutant. `index.ts` is left out, since it only re-exports. The config is `stryker.config.mjs`. Stryker and its runner are dev dependencies only.
- **`npm run mutate:lua` runs `scripts/mutate-lua.js` on the Lua.** For each script, it applies the same kinds of change Stryker does:
  - comparisons, such as `<` and `<=`, and `==` and `~=`
  - `+` and `-`, `*` and `/`
  - `math.floor` and `math.ceil`, `math.max` and `math.min`
  - `and` and `or`, and dropping a `not`
  - each integer `n` to `n + 1`
  - deleting each `redis.call` that stands alone
  
  Comments and strings are never changed. Each mutant is written to the file and that algorithm's integration tests run against it, along with the two suites that run every algorithm. The original file is restored afterwards, on Ctrl-C too. A mutant that Redis can't compile is reported as invalid, not killed. The unmutated script must pass first, with one retry, since a timing test can flake under load.
- **Neither runs in CI.** Each takes about 4 minutes on this Mac, and the numbers only matter when someone reads the survivors. Instead, AGENTS.md asks for them after changing logic in `src/`.
- **Every survivor is either killed with a test or listed below with the reason it can't change behaviour.** When the reason is that the code it changes can never run, the code goes.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Stryker alone | Leaves out the Lua, the riskiest code |
| Mutate the Lua by hand, as the break checks do | Already done for each fix, and it missed what the gaps below show |
| Mutate the scripts with a Lua mutation tool, such as those for busted | Those run Lua tests, not ours, and don't know Redis's `TIME` and `EVALSHA`. Ours runs the tests that already check the scripts. |
| A score threshold that fails the run | A score says little on its own: the list of survivors is the result. A threshold would invite tests written to kill mutants rather than to check behaviour. |

## Evidence

Raw output and the setup are in [data/0033-mutation-2026-11-08](data/0033-mutation-2026-11-08/): Apple M5 Pro, Node 25.8.2, Redis 7.4.12, Stryker 10.1.1, Vitest 4.1.12.

| Run | Stryker on `src/` | Lua scripts |
| --- | --- | --- |
| First, before any change | 94.1%: 1,417 of 1,506 caught, 88 survived, 1 not covered | 85.8%: 271 of 316 caught, 45 survived |
| Final | 97.95%: 1,435 of 1,465 caught, 30 survived | 94.0%: 281 of 299 caught, 18 survived |

Scores count killed and timed-out mutants against all valid ones. The totals fell because removed code took its mutants with it.

### Gaps it found, now tested

- **Token bucket:**
  - A change to `limit` alone, under a fixed `burst`, went unnoticed both in memory and in Lua, so the bucket kept refilling at the old rate.
  - The fraction carried across windows of different lengths could round up.
  - Nothing reached the guard for windows whose product passes 2^53.
  - Nothing checked that the sweep timer is `unref`'d.
- **Sliding window counter:** the fixed comparison steps never reached most of the denied cases.
  - Two cases are now pinned by tests of their own: the wait that ends 1 ms before the next window's end, and the in-window formula held to this window after a cut.
  - A dense comparison now checks every decision against the brute-force model: 60 random histories of 120 checks, some with a second rule on the key.
  - The model itself hadn't been updated for [0031](0031-two-rules-on-one-key.md).
- **Leaky bucket:** nothing reached a remainder of exactly 1 on a rule change, or exactly 1 unit of room. A dense comparison against its exact BigInt model now does.
- **The prelude's `rl_now`:** every algorithm test overrides the time, so nothing checked how Redis `TIME` becomes milliseconds. It could be scaled, rounded up, or lose its microseconds. A new test brackets it between two readings of `TIME`.
- **Identity:**
  - No test held each group of the NAT64, translated and mapped prefixes to its value, so `65:ff9b::…` could be read as IPv4.
  - A lone `[` before an address was stripped as if both brackets were there.
  - An empty `req.ip` now gives way to the connection's address, like any value that isn't an IP (0029). Before, it was `anon`.
- **Validation and errors:** error messages, `cause`s and names that no test read.
  - In rules files: a document that is a string or a number, and an import that rejects with something other than an Error.
  - In `rateLimit` and `prometheusHooks`: options or registries of the wrong type, and each factory's name in its error.
  - In the middleware: `durationMs` measured as now + start.
  - In rule matching: HEAD against a POST rule, and declaration order among many tied rules.
- **Replies:** `fromIoredis` would have converted `"12abc"` or `"1e3"` without the regex's end anchor.

### Code it showed could never run, now removed

- `formatIpv6`, a general RFC 5952 formatter, is now `formatPrefix64`. It's only ever given a /64 with four zero groups at the end, so the trailing run is always the one to compress.
- The leaky bucket's `floordiv` corrections. With [0032](0032-unknown-fields-throw-in-code-too.md)'s 2^51 cap, `math.floor(a / b)` is already exact: for |a| < 2^53, the rounding error is below 1 / b.
- Part of the sliding window counter's in-window check: `t >= 1`, and `curr + 1 <= limit`. The first always holds for a denied request. When the second is false, `t >= W - e`, so the in-window check rejects it anyway.
- The `ADAPTED` marker on adapted clients. It was only consulted for objects with `defineCommand`, which an adapted client never has.
- The declaration-order tie-break in rule sorting. `Array.prototype.sort` is stable.

### Survivors left, and why each can't change behaviour

Stryker, 33:

- **`hooks.ts`, 11:** in `callHook` and `isThenable`, every change either does the same thing or throws inside the hook's `try`, where errors are ignored by design (0019).
- **`rules-file.ts`, 5:**
  - Only `InvalidRuleError`s reach the source-prefix rethrow, so 4 changes to its condition make no difference.
  - With a single top-level field, joining with `''` or `', '` gives the same message.
- **`identify.ts`, 5:**
  - Replacing `''` with any other string that isn't an IP gives the same result: 2 survivors.
  - `Number.isFinite` already rejects non-numbers: 1.
  - In `formatPrefix64`, a group array of four never empties before a nonzero group: 2.
- **`token-bucket.ts`, 3:**
  - Converting units when the rule hasn't changed is the identity.
  - A product of windows exactly 2^53 is two powers of two, whose fraction is exact either way.
  - `unref`'s `timer !== null` (added in milestone 5's T6, for timers in a browser): `setInterval` never returns `null`.
- **One each, values that can't occur:**
  - `default-burst.ts`: undefined either way.
  - `load-script.ts` (`factory.ts` until T5 moved the file reads, 0024): an encoding of `''` still decodes the file, and the prelude: 2.
  - `redis/scripts.ts`: `isNonNegativeSafeInteger`'s `typeof` check, which `Number.isSafeInteger` already makes.
  - `fallback.ts`: `{ clock: undefined }` defaults the same way as `{}`.
  - `middleware.ts`: `isPositiveInteger`'s `typeof` check, which `Number.isSafeInteger` already makes, and a checker that is always defined.
  - `prometheus.ts`: `Number.isFinite` already rejects strings.
  - `rules.ts`: a path that's undefined is never a wildcard.
- **Runtime error:** hashing an empty source makes every script fail, which Stryker counts as caught.

Lua, 18:

- **Presence checks, 5:** `stored[2]` instead of `stored[1]`, in every script but the log, and twice in the fixed window. The fields are written together.
- **The fixed window's `start`, 1:** the window's start is stored for inspection but never read back.
- **The sliding window log, 3:**
  - Scores are epoch ms, so bounds of 0 or 1 make no difference: 2.
  - `LIMIT … 2` instead of 1 returns an extra entry that isn't read: 1.
- **The leaky bucket, 3:**
  - A remainder equal to `limit` gives the same times whether it's carried now or later.
  - `room >= 0` instead of `> 0` adds 0.
  - A drained key living 1 ms longer is the same as no key.
- **The counter, 3:**
  - At `prev = 0`, the division gives `t = inf`, which is rejected.
  - `prev = 1` can never yield an in-window wait.
  - At `t = W - e` exactly, case 2 gives the same wait.
- **The token bucket, 3:**
  - The 2^53 bound itself, and 2^53 + 1, can't be told apart from 2^53 in a double: 2.
  - Rounding the TTL down instead of up can expire a key up to 1 ms early, granting less than a token early. Redis TTLs run on real time, which a test can't hold still, so this one is known and left.

## Consequences

- After changing logic in `src/`, run the mutation tools on what changed: `npm run mutate -- --mutate src/<file>.ts`, or `npm run mutate:lua -- <script>`. Kill each new survivor, or add it here with its reason.
- `npm run mutate:lua` edits `src/algorithms/redis/*.lua` while it runs. Don't edit or test the scripts in the meantime. It restores each file after its mutants, and on Ctrl-C.
- Stryker adds 4 moderate `npm audit` advisories to the dev dependencies, for 14 in all, all in tooling.
