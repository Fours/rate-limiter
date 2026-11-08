import { systemClock } from '../clock.js';
import type { Algorithm, Clock, Decision, Rule } from '../types.js';

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export interface TokenBucketOptions {
  clock?: Clock;
  /** How often full buckets are dropped from memory. Positive integer ms; default 60 000. */
  sweepIntervalMs?: number;
}

export interface TokenBucket extends Algorithm {
  /** Stops the sweep timer. `check` keeps working afterwards. */
  close(): void;
  /** Drops buckets that have refilled to full. Runs on the interval; exposed for tests. */
  sweep(): void;
  /** Number of tracked keys. For tests and observability. */
  readonly size: number;
}

/**
 * Tokens are stored as integer "units", where one token is `windowMs` units and
 * the bucket refills `limit` units per ms. That is the spec's float maths scaled
 * by `windowMs`, so every value stays an exact integer: after a denial, waiting
 * exactly `resetMs` always yields one token, with no 0.999… rounding misses.
 * It holds up to `burst` tokens, `limit` unless the rule says otherwise. Requires
 * `limit * windowMs` and `burst * windowMs <= Number.MAX_SAFE_INTEGER`, which
 * rule validation checks at startup.
 */
interface Bucket {
  units: number;
  /** High-water mark of the clock, so time that ran backwards is never refilled twice. */
  lastRefillMs: number;
  limit: number;
  windowMs: number;
  burst: number;
}

export function createTokenBucket(opts: TokenBucketOptions = {}): TokenBucket {
  const clock = opts.clock ?? systemClock;
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs <= 0) {
    throw new RangeError(
      `sweepIntervalMs must be a positive integer, got ${String(sweepIntervalMs)}`,
    );
  }

  const buckets = new Map<string, Bucket>();

  function sweep(): void {
    const now = clock.now();
    for (const [key, bucket] of buckets) {
      refill(bucket, now);
      // A full bucket is indistinguishable from a new one, so it holds nothing worth keeping.
      if (bucket.units >= capacity(bucket)) buckets.delete(key);
    }
  }

  // unref() so an idle limiter never keeps the process alive.
  let timer: NodeJS.Timeout | undefined = setInterval(sweep, sweepIntervalMs);
  timer.unref();

  return {
    supportsBurst: true,
    check(key: string, rule: Rule): Promise<Decision> {
      // Read, decide and write with no await in between, so concurrent checks can't interleave.
      const now = clock.now();
      const bucket = bucketFor(buckets, key, rule, now);
      refill(bucket, now);
      const allowed = bucket.units >= bucket.windowMs;
      if (allowed) bucket.units -= bucket.windowMs;
      return Promise.resolve(decide(bucket, allowed));
    },
    close(): void {
      clearInterval(timer);
      timer = undefined;
    },
    sweep,
    get size(): number {
      return buckets.size;
    },
  };
}

function bucketFor(buckets: Map<string, Bucket>, key: string, rule: Rule, now: number): Bucket {
  const burst = rule.burst ?? rule.limit;
  const existing = buckets.get(key);
  if (existing === undefined) {
    // A new bucket starts full.
    const bucket: Bucket = {
      units: burst * rule.windowMs,
      lastRefillMs: now,
      limit: rule.limit,
      windowMs: rule.windowMs,
      burst,
    };
    buckets.set(key, bucket);
    return bucket;
  }
  if (
    existing.limit !== rule.limit ||
    existing.windowMs !== rule.windowMs ||
    existing.burst !== burst
  ) {
    // The rule changed under this key (e.g. config reload). Carry over whole tokens only,
    // rounding down and capped at the new burst, so a change never grants more than the client
    // already had, nor more than the new rule holds.
    refill(existing, now);
    const tokens = Math.min(burst, Math.floor(existing.units / existing.windowMs));
    existing.units = tokens * rule.windowMs;
    existing.limit = rule.limit;
    existing.windowMs = rule.windowMs;
    existing.burst = burst;
  }
  return existing;
}

function refill(bucket: Bucket, now: number): void {
  const elapsed = Math.max(0, now - bucket.lastRefillMs);
  bucket.units = Math.min(capacity(bucket), bucket.units + elapsed * bucket.limit);
  bucket.lastRefillMs = Math.max(bucket.lastRefillMs, now);
}

function capacity(bucket: Bucket): number {
  return bucket.burst * bucket.windowMs;
}

function decide(bucket: Bucket, allowed: boolean): Decision {
  // Allowed: time until full. Denied: time until the next token (decision 0003).
  const missingUnits = allowed ? capacity(bucket) - bucket.units : bucket.windowMs - bucket.units;
  return {
    allowed,
    remaining: Math.floor(bucket.units / bucket.windowMs),
    resetMs: Math.ceil(missingUnits / bucket.limit),
  };
}
