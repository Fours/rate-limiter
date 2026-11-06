# 0007. Use Redis `TIME` inside scripts, not app time

- **Status:** Proposed
- **Date:** 2026-11-06
- **Milestone:** 2

## Context

Time-based algorithms compare "now" with stored timestamps. If each app instance sends its own clock, skew between instances adds or removes tokens.

## Decision

Scripts read `redis.call('TIME')` for the current time. App code never sends a timestamp. In-memory algorithms take an injected `Clock`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| The app sends `Date.now()` | Clock skew between instances changes the limit |
| Trusting NTP to keep app clocks in step | Reduces skew but doesn't remove it, and the limiter can't check it |

## Evidence

To gather in milestone 2: a test where instances report clocks that are off by ±2 s gives the same decisions when using Redis time, and different decisions when using app time.

## Consequences

Older Redis versions need script effects replication when scripts call `TIME`. Redis 7 does this by default. Tests of Redis algorithms can't use the fake clock, so they control time through the window sizes instead.
