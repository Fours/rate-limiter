import type { Request, RequestHandler } from 'express';
import { createTokenBucket } from './algorithms/token-bucket.js';
import { rateLimitHeaders, retryAfter } from './headers.js';
import { buildKey, defaultIdentify } from './identify.js';
import { createMatcher } from './rules.js';
import type { Algorithm, Decision, Rule } from './types.js';

export interface RateLimitOptions {
  readonly rules: readonly Rule[];
  /** Default: an in-memory token bucket, which `close()` stops. */
  readonly algorithm?: Algorithm;
  /** Default: API key, then user ID, then IP, then "anon". */
  readonly identify?: (req: Request) => string;
  /** The request's tier, for rules that set `tier`. Default: none. */
  readonly tier?: (req: Request) => string | undefined;
}

export type RateLimitMiddleware = RequestHandler & {
  /** Stops the default algorithm's sweep timer. An algorithm passed in is left alone. */
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
  const { algorithm, close } = resolveAlgorithm(opts.algorithm);
  const identify = opts.identify ?? defaultIdentify;
  const tierOf = opts.tier;

  const handler: RequestHandler = async (req, res, next) => {
    let rule: Rule | undefined;
    let decision: Decision;
    try {
      rule = match(req, tierOf?.(req));
      if (rule === undefined) {
        next();
        return;
      }
      decision = await algorithm.check(buildKey(rule, identify(req)), rule);
    } catch (err) {
      // Milestone 4 replaces this with the timeout and in-memory fallback (decision 0010).
      next(err);
      return;
    }

    // Outside the try, so an error thrown further down the chain can't reach next() twice.
    res.set(rateLimitHeaders(rule, decision));
    if (decision.allowed) {
      next();
      return;
    }
    res.set('Retry-After', retryAfter(decision));
    res.status(429).json({ error: 'rate_limited' });
  };

  return Object.assign(handler, { close });
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
