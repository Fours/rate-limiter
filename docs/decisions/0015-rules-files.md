# 0015. Rules files: one shape, strict fields, optional YAML

- **Status:** Accepted
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

Milestone 2 loads rules from JSON or YAML. A typo in a hand-edited file shouldn't quietly change a limit. YAML needs a parser, and AGENTS.md rules out runtime dependencies unless a spec calls for one. The project plan also lists "API key" as something rules can target.

## Decision

- A rules file holds `{ rules: Rule[] }`, never a bare list, which leaves room for top-level settings later. Unknown top-level fields are rejected too, so a typo like `rule:` fails.
- `loadRules(path)` picks the format from `.json`, `.yaml` or `.yml`. `parseRules(text, format, source?)` parses text from elsewhere, and `source` names it in errors.
- Rules are checked with the milestone 1 `validateRules`. Files also reject unknown fields, so `limt: 10` fails at startup. Errors name the file, the rule's position and its id.
- JSON uses `JSON.parse`. YAML uses the `yaml` package, an optional peer dependency loaded with a dynamic `import()`. If it isn't installed, the error says to install it.
- There are no per-API-key rules. To give a key different limits, map it to a tier in `opts.tier`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Ignore unknown fields | A typo silently removes a constraint, for example `methd: POST` makes a rule cover every method |
| `yaml` as a regular dependency | Every user installs a parser, including those who only use JSON or code |
| JSON only | YAML is what people hand-edit, and the project plan asks for both |
| An `apiKey` field on rules | Puts raw keys in config files, against [0002](0002-hash-api-keys.md). Tiers already cover it. |

## Evidence

From milestone 2, T9, in `test/rules-file.test.ts`:

- The same two rules load identically from `.json`, `.yaml` and `.yml` fixtures.
- An unknown field (`limt`, `methd`, an unknown top-level key), a bad value, a rule that isn't an object, a duplicate id, and an empty file or a missing, null or bare `rules` list each fail with an `InvalidRuleError` naming the source, the rule's position and its id, such as `typo.yaml: rules[1] ("orders"): unknown field "limt"`.
- A YAML import that fails with `ERR_MODULE_NOT_FOUND`, the code Node 22 gives for a missing package, becomes "needs the optional "yaml" package: run `npm install yaml`". JSON still loads, and other import errors pass through unchanged. The built `dist/` was also run in a folder with no `yaml` installed and gave the same message.
- `{ "rules": [] }` is valid. A missing file rejects with `ENOENT` instead of returning no rules.
- A type test fails `typecheck` if `Rule` gains a field that the file schema doesn't list.

Each of these was checked by breaking the code: turning off the unknown-field check, the missing-`yaml` message, the missing-`rules` guard and the missing-file error, and dropping `tier` from the allowed fields. Each change made a test fail.

`JSON.parse` keeps the last of two duplicate keys, while `yaml` rejects them. That gap is accepted rather than fixed with a custom JSON parser.

## Consequences

Loading is async because of the dynamic import, so apps `await loadRules()` before `rateLimit()`. Bad files still fail at startup. Adding a field to `Rule` later means adding it to the file schema too, or files that use it will be rejected.
