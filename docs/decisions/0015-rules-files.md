# 0015. Rules files: one shape, strict fields, optional YAML

- **Status:** Proposed
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

Milestone 2 loads rules from JSON or YAML. A typo in a hand-edited file shouldn't quietly change a limit. YAML needs a parser, and AGENTS.md rules out runtime dependencies unless a spec calls for one. The project plan also lists "API key" as something rules can target.

## Decision

- A rules file holds `{ rules: Rule[] }`, never a bare list, which leaves room for top-level settings later.
- `loadRules(path)` picks the format from `.json`, `.yaml` or `.yml`. `parseRules(text, format)` does the same for text from elsewhere.
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

To gather in milestone 2, T9: tests load identical rules from all three extensions, reject each kind of bad field with a message naming the file and rule, and show the missing-`yaml` error.

## Consequences

Loading is async because of the dynamic import, so apps `await loadRules()` before `rateLimit()`. Bad files still fail at startup. Adding a field to `Rule` later means adding it to the file schema too, or files that use it will be rejected.
