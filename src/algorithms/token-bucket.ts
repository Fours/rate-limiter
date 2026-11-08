import { MAX_TIMER_MS, systemClock } from '../clock.js';
import type { Algorithm, Clock, Decision, Rule } from '../types.js';

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Options for {@link createTokenBucket}. */
export interface TokenBucketOptions {
  /** Where time comes from. Default {@link systemClock}. Inject one to test against fake time. */
  clock?: Clock;
  /** How often full buckets are dropped from memory. Positive integer ms, at most 2^31 - 1; default 60 000. */
  sweepIntervalMs?: number;
}

/** The in-memory token bucket from {@link createTokenBucket}. */
export interface TokenBucket extends Algorithm {
  readonly supportsBurst: true;
  /**
   * Stops the timer that drops full buckets from memory, so the process can exit. `check` keeps
   * working afterwards. Safe to call more than once.
   */
  close(): void;
}

/** For tests only: the same bucket, with its sweep and size exposed. Not exported publicly. */
export interface InspectableTokenBucket extends TokenBucket {
  /** Drops buckets that have refilled to full. Runs on the interval. */
  sweep(): void;
  /** Number of tracked keys. */
  readonly size: number;
}

/**
 * Tokens are stored as integer "units", where one token is `windowMs` units and
 * the bucket refills `limit` units per ms. That is the usual float maths scaled
 * by `windowMs`, so every value stays an exact integer: after a denial, waiting
 * exactly `resetMs` always yields one token, with no 0.999… rounding misses.
 * It holds up to `burst` tokens, `limit` unless the rule says otherwise. Requires
 * `limit * windowMs` and `burst * windowMs` of at most 2^51, which rule validation
 * checks at startup.
 */
interface Bucket {
  units: number;
  /** High-water mark of the clock, so time that ran backwards is never refilled twice. */
  lastRefillMs: number;
  limit: number;
  windowMs: number;
  burst: number;
}

/**
 * A token bucket in this process's memory: up to `burst` requests at once (`limit` by default),
 * refilling steadily at `limit` per `windowMs`. It's the default algorithm of {@link rateLimit}.
 * Limits aren't shared between processes; use {@link createRedisTokenBucket} for that.
 *
 * Buckets that have refilled to full are dropped every `sweepIntervalMs`, so memory follows the
 * active clients. Call `close()` on shutdown if you created it yourself.
 *
 * @throws RangeError if `sweepIntervalMs` isn't a positive integer.
 */
export function createTokenBucket(opts: TokenBucketOptions = {}): TokenBucket {
  // A new object, so the test-only sweep and size aren't reachable from the public one.
  const bucket = createTokenBucketForTest(opts);
  return {
    supportsBurst: true,
    check: (key, rule) => bucket.check(key, rule),
    close: () => {
      bucket.close();
    },
  };
}

/** For tests only: {@link createTokenBucket}, with its sweep and size exposed. */
export function createTokenBucketForTest(opts: TokenBucketOptions = {}): InspectableTokenBucket {
  const clock = opts.clock ?? systemClock;
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs <= 0) {
    throw new RangeError(
      `sweepIntervalMs must be a positive integer, got ${String(sweepIntervalMs)}`,
    );
  }
  // Longer would run as 1 ms: a sweep over every bucket, a thousand times a second.
  if (sweepIntervalMs > MAX_TIMER_MS) {
    throw new RangeError(
      `sweepIntervalMs must be at most ${String(MAX_TIMER_MS)}, got ${String(sweepIntervalMs)}`,
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
    // The rule changed under this key, or two rules share it, as in a rolling deploy (0031).
    refill(existing, now);
    // Full under the old rule is the same as swept, so it starts full under the new rule too,
    // and the answer doesn't depend on when the sweep runs. Redis does the same, where a full
    // bucket's key has expired.
    existing.units =
      existing.units === capacity(existing)
        ? burst * rule.windowMs
        : carryUnits(existing.units, existing.windowMs, rule.windowMs, burst);
    existing.limit = rule.limit;
    existing.windowMs = rule.windowMs;
    existing.burst = burst;
  }
  return existing;
}

/**
 * Units from one window's scale to another's: the tokens, the fraction of the next one included,
 * rounded down to a unit and capped at the new burst. So never more than the client had, nor than
 * the new rule holds. Dropping the fraction would lock out a client whose checks alternate
 * between two rules (decision 0031). The same maths as token-bucket.lua.
 */
function carryUnits(
  units: number,
  fromWindowMs: number,
  toWindowMs: number,
  burst: number,
): number {
  const tokens = Math.floor(units / fromWindowMs);
  const part = units % fromWindowMs;
  // part * toWindowMs / fromWindowMs is exact only while the product of the windows fits.
  const fraction =
    fromWindowMs * toWindowMs <= 2 ** 53 ? Math.floor((part * toWindowMs) / fromWindowMs) : 0;
  return Math.min(burst * toWindowMs, tokens * toWindowMs + fraction);
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
