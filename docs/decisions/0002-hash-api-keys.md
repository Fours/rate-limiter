# 0002. Hash API keys before they reach storage keys

- **Status:** Superseded by [0026](0026-no-unverified-api-keys.md): the default no longer reads API keys at all. Its rule, that a raw key never reaches storage, logs or metrics, still holds.
- **Date:** 2026-11-06
- **Milestone:** 1

## Context

Clients are identified by API key first. The client ID ends up in Redis keys (`rl:{rule}:{clientId}`), and possibly in logs and debugging output. Anyone who can read Redis or the logs would then see live credentials.

## Decision

An API key becomes `key_<first 16 hex chars of sha256(apiKey)>`. User IDs and IPs are not secret and are used as they are.

## Alternatives considered

| Option | Why not |
| --- | --- |
| The raw API key in the storage key | Leaks credentials to anyone with Redis or log access |
| HMAC with a server secret | Stronger against guessing, but adds a secret to manage. Revisit if the keys are short or easy to guess. |
| Mapping keys to an account ID | Needs a lookup the limiter doesn't own. A custom `identify` covers this. |

## Evidence

A unit test asserts that the raw key never appears in the output of `defaultIdentify`. With 16 hex chars (64 bits), a collision between two real keys is negligible at any realistic number of keys.

## Consequences

Operators can't read the API key back from Redis. To find a client's bucket, they hash the key the same way.
