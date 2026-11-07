import type { Request, RequestHandler } from 'express';
import { createTokenBucket } from './algorithms/token-bucket.js';
import { createFallback, type Fallback } from './fallback.js';
import { rateLimitHeaders, retryAfter } from './headers.js';
import { resolveHooks, type RateLimitHooks } from './hooks.js';
import { buildKey, defaultIdentify } from './identify.js';
import { createMatcher } from './rules.js';
import { RateLimitTimeoutError, withTimeout } from './timeout.js';
import type { Algorithm, Decision, Rule } from './types.js';

const DEFAULT_TIMEOUT_MS = 50;

export interface FallbackOptions {
  /**
   * How many instances share the limit. Each one allows `ceil(limit / instances)` during an
   * outage, so together they allow about `limit`. Positive integer; default 1.
   */
  readonly instances?: number;
}

export interface RateLimitOptions {
  readonly rules: readonly Rule[];
  /** Default: an in-memory token bucket, which `close()` stops. */
  readonly algorithm?: Algorithm;
  /** Default: API key, then user ID, then IP, then "anon". */
  readonly identify?: (req: Request) => string;
  /** The request's tier, for rules that set `tier`. Default: none. */
  readonly tier?: (req: Request) => string | undefined;
  /** How long a check gets before the fallback answers instead. Positive integer ms; default 50. */
  readonly timeoutMs?: number;
  /**
   * Answers from memory when a check fails or times out, so a Redis outage isn't an API outage
   * (decision 0010). `false` sends the error, or a `RateLimitTimeoutError`, to Express's error
   * handler instead. Default `{ instances: 1 }`.
   */
  readonly fallback?: FallbackOptions | false;
  /** Called for each decision and each fallback, for metrics and logs (decision 0019). */
  readonly hooks?: RateLimitHooks;
}

export type RateLimitMiddleware = RequestHandler & {
  /** Stops the default algorithm's and the fallback's sweep timers. An algorithm passed in is left alone. */
  close(): void;
};

/**
 * Express middleware that limits matching requests. Every option is checked
 * here, so bad configuration fails at startup, never at request time.
 */
export function rateLimit(opts: RateLimitOptions): RateLimitMiddleware {
  // Checked at runtime because plain JS callers, and rules loaded from files, bypass the types.
  const match = createMatcher(opts.rules);
  assertOptionalFunction(opts.identify, 'identify');
  assertOptionalFunction(opts.tier, 'tier');
  const timeoutMs = resolveTimeout(opts.timeoutMs);
  const fallback = resolveFallback(opts.fallback);
  const hooks = resolveHooks(opts.hooks);
  const { algorithm, close } = resolveAlgorithm(opts.algorithm);
  const identify = opts.identify ?? defaultIdentify;
  const tierOf = opts.tier;

  const handler: RequestHandler = async (req, res, next) => {
    // Like the benchmark app's Server-Timing: from entering the middleware, identify included.
    const start = performance.now();
    // The rule the decision was made against: the fallback's is scaled down, and the headers
    // report its limit, since RateLimit-Remaining counts against it.
    let applied: Rule;
    let decision: Decision;
    try {
      const rule = match(req, tierOf?.(req));
      if (rule === undefined) {
        next();
        return;
      }
      const key = buildKey(rule, identify(req));
      // Only the check is bounded and falls back. An error in identify, tier or matching is a
      // bug in the caller's code, not an outage, so it reaches the catch below.
      const result = await withTimeout(() => algorithm.check(key, rule), timeoutMs);
      let source: 'primary' | 'fallback' = 'primary';
      if (result.ok) {
        applied = rule;
        decision = result.value;
      } else if (fallback === undefined) {
        next(result.reason === 'timeout' ? new RateLimitTimeoutError(timeoutMs) : result.error);
        return;
      } else {
        hooks.onFallback(
          result.reason === 'timeout'
            ? { req, rule, key, reason: 'timeout' }
            : { req, rule, key, reason: 'error', error: result.error },
        );
        ({ rule: applied, decision } = await fallback.check(key, rule));
        source = 'fallback';
      }
      const durationMs = performance.now() - start;
      hooks.onDecision({ req, rule, limit: applied.limit, key, decision, source, durationMs });
    } catch (err) {
      next(err);
      return;
    }

    // Outside the try, so an error thrown further down the chain can't reach next() twice.
    res.set(rateLimitHeaders(applied, decision));
    if (decision.allowed) {
      next();
      return;
    }
    res.set('Retry-After', retryAfter(decision));
    res.status(429).json({ error: 'rate_limited' });
  };

  return Object.assign(handler, {
    close: () => {
      close();
      fallback?.close();
    },
  });
}

function resolveTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!isPositiveInteger(value)) {
    throw new RangeError(`rateLimit: timeoutMs must be a positive integer, got ${show(value)}`);
  }
  return value;
}

function resolveFallback(value: unknown): Fallback | undefined {
  if (value === false) return undefined;
  if (value === undefined) return createFallback(1);
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('rateLimit: fallback must be { instances } or false');
  }
  const instances: unknown = 'instances' in value ? value.instances : undefined;
  if (instances === undefined) return createFallback(1);
  if (!isPositiveInteger(instances)) {
    throw new RangeError(
      `rateLimit: fallback.instances must be a positive integer, got ${show(instances)}`,
    );
  }
  return createFallback(instances);
}

/** For error messages: quotes strings, so "50" and 50 read differently. */
function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null)
    return String(value);
  return typeof value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Only an algorithm we created is ours to close. A caller's may be shared with other limiters. */
function resolveAlgorithm(given: unknown): { algorithm: Algorithm; close: () => void } {
  if (given === undefined) {
    const bucket = createTokenBucket();
    return {
      algorithm: bucket,
      close: () => {
        bucket.close();
      },
    };
  }
  if (!isAlgorithm(given)) {
    throw new TypeError('rateLimit: algorithm must have a check(key, rule) function');
  }
  return {
    algorithm: given,
    close: () => {
      // Not ours: see above.
    },
  };
}

function isAlgorithm(value: unknown): value is Algorithm {
  return (
    typeof value === 'object' &&
    value !== null &&
    'check' in value &&
    typeof value.check === 'function'
  );
}

function assertOptionalFunction(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`rateLimit: ${name} must be a function`);
  }
}
