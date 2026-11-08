import type { Request, RequestHandler } from 'express';
import { createTokenBucket } from './algorithms/token-bucket.js';
import { defaultBurstOf } from './algorithms/default-burst.js';
import { createFallback, type Fallback } from './fallback.js';
import { rateLimitHeaders, retryAfter } from './headers.js';
import { resolveHooks, type RateLimitHooks } from './hooks.js';
import { MAX_TIMER_MS } from './clock.js';
import { buildKey, defaultIdentify } from './identify.js';
import { createMatcher, InvalidRuleError } from './rules.js';
import { RateLimitTimeoutError, withTimeout } from './timeout.js';
import type { Algorithm, Decision, Rule } from './types.js';

const DEFAULT_TIMEOUT_MS = 50;

/** Settings for the in-memory fallback: `rateLimit`'s `fallback` option. */
export interface FallbackOptions {
  /**
   * How many instances share the limit. Each one allows `ceil(limit / instances)` during an
   * outage, so together they allow about `limit`. Positive integer; default 1.
   */
  readonly instances?: number;
}

/** Options for {@link rateLimit}. Only `rules` is required. */
export interface RateLimitOptions {
  /** The limits. Validated at startup: a bad rule throws an {@link InvalidRuleError}. */
  readonly rules: readonly Rule[];
  /** For rules that name no algorithm. Default: an in-memory token bucket, which `close()` stops. */
  readonly algorithm?: Algorithm;
  /**
   * Algorithms by name, for rules that set `algorithm`: `{ exact: createRedisSlidingWindowLog(...) }`
   * with a rule's `algorithm: 'exact'`. The names are yours. `close()` leaves these alone
   * (decision 0023).
   */
  readonly algorithms?: Readonly<Record<string, Algorithm>>;
  /** Default: `req.user.id`, then the IP, then "anon". Never an unverified API key (decision 0026). */
  readonly identify?: (req: Request) => string;
  /** The request's tier, for rules that set `tier`. Default: none. */
  readonly tier?: (req: Request) => string | undefined;
  /** How long a check gets before the fallback answers instead. Positive integer ms, at most 2^31 - 1; default 50. */
  readonly timeoutMs?: number;
  /**
   * Answers from memory when a check fails or times out, so a Redis outage isn't an API outage
   * (decision 0010). `false` sends the error, or a `RateLimitTimeoutError`, to Express's error
   * handler instead. Default `{ instances: 1 }`.
   */
  readonly fallback?: FallbackOptions | false;
  /** Called for each decision and each fallback, for metrics and logs (decision 0019). */
  readonly hooks?: RateLimitHooks;
  /**
   * Starts every storage key, `{prefix}:{rule.id}:{clientId}`. Default `rl`. Give each limiter
   * that shares a Redis with another its own, so their rules can't write the same keys
   * (decision 0028). Letters, digits, `_` and `-` only.
   */
  readonly prefix?: string;
}

/** Express middleware from {@link rateLimit}, with a `close()` for shutdown. */
export type RateLimitMiddleware = RequestHandler & {
  /** Stops the default algorithm's and the fallback's sweep timers. An algorithm passed in is left alone. */
  close(): void;
};

/**
 * Express middleware that limits matching requests. A request over its limit gets a 429 with
 * `{ "error": "rate_limited" }`, and every limited request gets `RateLimit-*` headers.
 *
 * Every option is checked here, so bad configuration fails at startup, never at request time.
 *
 * @throws InvalidRuleError for a bad rule, an unknown `algorithm` name, or a `burst` on a rule
 *   whose algorithm doesn't take one.
 * @throws TypeError or RangeError for other bad options.
 */
export function rateLimit(opts: RateLimitOptions): RateLimitMiddleware {
  // Checked at runtime because plain JS callers, and rules loaded from files, bypass the types.
  const match = createMatcher(opts.rules);
  assertOptionalFunction(opts.identify, 'identify');
  assertOptionalFunction(opts.tier, 'tier');
  const timeoutMs = resolveTimeout(opts.timeoutMs);
  const fallback = resolveFallback(opts.fallback);
  const hooks = resolveHooks(opts.hooks);
  const prefix = resolvePrefix(opts.prefix);
  const { algorithm, close } = resolveAlgorithm(opts.algorithm);
  const algorithmFor = resolveRuleAlgorithms(opts.rules, algorithm, opts.algorithms);
  const fallbackRuleFor = fallbackRules(opts.rules, algorithmFor);
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
      const key = buildKey(rule, identify(req), prefix);
      // Every rule was resolved at startup, so a missing entry can't happen; the default is a
      // safe answer if it ever did.
      const checker = algorithmFor.get(rule.id) ?? algorithm;
      // Only the check is bounded and falls back. An error in identify, tier or matching is a
      // bug in the caller's code, not an outage, so it reaches the catch below.
      const result = await withTimeout(() => checker.check(key, rule), timeoutMs);
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
        ({ rule: applied, decision } = await fallback.check(
          key,
          fallbackRuleFor.get(rule.id) ?? rule,
        ));
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
  // Longer would run as 1 ms, so every check would time out and the fallback answer them all.
  if (value > MAX_TIMER_MS) {
    throw new RangeError(
      `rateLimit: timeoutMs must be at most ${String(MAX_TIMER_MS)}, got ${String(value)}`,
    );
  }
  return value;
}

function resolvePrefix(value: unknown): string {
  if (value === undefined) return 'rl';
  // No ":", so two different prefixes can never produce the same key, whatever the rule IDs. No
  // braces either, which Redis Cluster would read as a hash tag.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(
      `rateLimit: prefix must be a non-empty string of letters, digits, _ and -, got ${show(value)}`,
    );
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

/**
 * Each rule's algorithm by rule ID: the one it names in `algorithms`, or the default (decision
 * 0023). A name that isn't there, or a burst on a rule whose algorithm can't honour it (decision
 * 0022), fails here at startup rather than at request time or silently. The rules have already
 * been validated by createMatcher.
 */
/**
 * The rules the fallback checks: each with the burst its own algorithm would use, where that
 * isn't `limit`. The fallback is a token bucket, which reads a missing burst as `limit`, so a
 * leaky bucket rule, with no burst by default, would otherwise take its whole limit at once
 * during an outage.
 */
function fallbackRules(
  rules: readonly Rule[],
  algorithmFor: ReadonlyMap<string, Algorithm>,
): Map<string, Rule> {
  const out = new Map<string, Rule>();
  for (const rule of rules) {
    const checker = algorithmFor.get(rule.id);
    const burst = checker === undefined ? undefined : defaultBurstOf(checker);
    if (rule.burst === undefined && burst !== undefined) out.set(rule.id, { ...rule, burst });
  }
  return out;
}

function resolveRuleAlgorithms(
  rules: readonly Rule[],
  fallbackDefault: Algorithm,
  given: unknown,
): Map<string, Algorithm> {
  const named = resolveNamedAlgorithms(given);
  const out = new Map<string, Algorithm>();
  for (const rule of rules) {
    let algorithm = fallbackDefault;
    if (rule.algorithm !== undefined) {
      const found = Object.hasOwn(named, rule.algorithm) ? named[rule.algorithm] : undefined;
      if (found === undefined) {
        const names = Object.keys(named);
        throw new InvalidRuleError(
          `rateLimit: rule ${JSON.stringify(rule.id)} names algorithm ${JSON.stringify(rule.algorithm)}, ` +
            (names.length === 0
              ? 'but no algorithms option was given.'
              : `which isn't in the algorithms option. Its names are ${names.map((n) => JSON.stringify(n)).join(', ')}.`),
        );
      }
      algorithm = found;
    }
    if (rule.burst !== undefined && algorithm.supportsBurst !== true) {
      throw new InvalidRuleError(
        `rateLimit: rule ${JSON.stringify(rule.id)} has a burst, but its algorithm doesn't take one. ` +
          'Only the token bucket and the leaky bucket do; remove the burst or change the algorithm.',
      );
    }
    out.set(rule.id, algorithm);
  }
  return out;
}

function resolveNamedAlgorithms(given: unknown): Readonly<Record<string, Algorithm>> {
  if (given === undefined) return {};
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw new TypeError('rateLimit: algorithms must be an object of algorithms by name');
  }
  for (const [name, value] of Object.entries(given)) {
    if (!isAlgorithm(value)) {
      throw new TypeError(`rateLimit: algorithms.${name} must have a check(key, rule) function`);
    }
  }
  return given as Readonly<Record<string, Algorithm>>;
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
