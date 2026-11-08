# 0032. Unknown rule fields and options throw in code too, not only in files

- **Status:** Accepted. Extends [0015](0015-rules-files.md) from rules files to rules and options written in code.
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

[0015](0015-rules-files.md) makes rules files reject unknown fields, because "`methd: POST` makes a rule cover every method". The same typo in a rule written in code was ignored: `validateRules` checked the known fields' values, but not whether a field was known. The options were the same. `rateLimit({ rules, fallbak: false })` kept the fallback on, and `timeoutMS: 10` kept the 50 ms default.

TypeScript catches these in a literal object, but not in a plain JS caller, a config object built elsewhere, or a rule spread from a wider type. The 1.0 correctness review showed the method typo turning a POST-only limit into one on every method, with no error. AGENTS.md says invalid configuration throws at startup.

## Decision

- **`validateRules` rejects any field not in `RULE_FIELDS`,** with the message rules files already gave: `rules[1] ("orders"): unknown field "limt"; allowed fields are …`. Rules files now get it from `validateRules`, so the two can't drift.
- **`rateLimit` rejects an unknown option,** an unknown `fallback` option and an unknown hook name, each with a `TypeError` that lists the valid names.
- A type test keeps the list of options in step with `RateLimitOptions`, as one already did for `RULE_FIELDS` and `Rule`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep code lenient, as 0015 scoped strictness to files | The typo is just as silent in code, and a plain JS caller has no type checker to catch it |
| Warn instead of throwing | The project throws on every other bad option at startup, and a warning in a log is easy to miss |
| Ignore fields whose names start with `_`, for the caller's own notes | Nothing needs it yet. It can be added without breaking anyone. |

## Evidence

- `test/rules.test.ts`: `methd`, `limt`, `windowMS` and `paths` on a rule in code each throw `InvalidRuleError`, with the same message as in files. `test/rules-file.test.ts` still passes unchanged.
- `test/middleware.test.ts`: `fallbak`, `timeoutMS`, `fallback: { instance }`, a misspelt hook, and options that aren't an object each throw at startup.
- `test/types.test.ts` fails `typecheck` if `RateLimitOptions` gains an option that `OPTION_NAMES` doesn't list.
- Break checks: turning off the rule check fails 8 tests, and the options check 3.

## Consequences

- Code that passed extra fields on rules or options, which did nothing before, now throws at startup. No version was published.
- A rule can't carry the caller's own metadata. Keep it in a separate map keyed by the rule's `id`.
