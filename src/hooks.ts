import type { Request } from 'express';
import type { Decision, Rule } from './types.js';

/** One limited request's decision (decision 0019). */
export interface DecisionEvent {
  /** The request as it arrived. Its headers can hold a raw API key: don't log them whole. */
  readonly req: Request;
  /** The rule as configured, even when the fallback decided against a scaled copy. */
  readonly rule: Rule;
  /** The limit the decision was made against: `rule.limit`, or the fallback's share of it. */
  readonly limit: number;
  /** `rl:{rule.id}:{clientId}`, with API keys hashed. It can hold an IP: not a metric label. */
  readonly key: string;
  /** What the algorithm, or the fallback, decided. */
  readonly decision: Decision;
  /** `primary` from the configured algorithm, `fallback` from the in-memory fallback. */
  readonly source: 'primary' | 'fallback';
  /** From entering the middleware to the decision, from performance.now(). Fractional ms. */
  readonly durationMs: number;
}

/** A check that timed out or failed, just before the fallback answers it. */
export type FallbackEvent = {
  /** The request as it arrived. Its headers can hold a raw API key: don't log them whole. */
  readonly req: Request;
  /** The rule as configured. */
  readonly rule: Rule;
  /** `rl:{rule.id}:{clientId}`, with API keys hashed. It can hold an IP: not a metric label. */
  readonly key: string;
} &
  // Why the fallback answers: the check took longer than `timeoutMs`, or it failed with `error`.
  ({ readonly reason: 'timeout' } | { readonly reason: 'error'; readonly error: unknown });

/**
 * Called synchronously, and never allowed to affect the request: a hook that throws, or returns
 * a promise that rejects, is ignored. What a hook returns is never awaited.
 */
export interface RateLimitHooks {
  /** Called once for every limited request, allowed or denied, after its decision. */
  readonly onDecision?: (event: DecisionEvent) => unknown;
  /** Called when a check times out or fails, before the fallback answers it. */
  readonly onFallback?: (event: FallbackEvent) => unknown;
}

export interface ResolvedHooks {
  onDecision(event: DecisionEvent): void;
  onFallback(event: FallbackEvent): void;
}

const HOOK_NAMES = ['onDecision', 'onFallback'] as const;

/** Checks the hooks at startup, so a typo fails there and not on the first request. */
export function resolveHooks(value: unknown): ResolvedHooks {
  if (value === undefined) return { onDecision: noop, onFallback: noop };
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('rateLimit: hooks must be an object of functions');
  }
  const given = value as Record<string, unknown>;
  for (const name of HOOK_NAMES) {
    if (given[name] !== undefined && typeof given[name] !== 'function') {
      throw new TypeError(`rateLimit: hooks.${name} must be a function`);
    }
  }
  const { onDecision, onFallback } = value as RateLimitHooks;
  return {
    onDecision: (event) => {
      callHook(onDecision, event);
    },
    onFallback: (event) => {
      callHook(onFallback, event);
    },
  };
}

/**
 * The limiter must never fail a request for its own bookkeeping, so a hook's error goes nowhere
 * (decision 0019). A returned promise gets a handler, so its rejection isn't unhandled either.
 */
function callHook<E>(hook: ((event: E) => unknown) | undefined, event: E): void {
  if (hook === undefined) return;
  try {
    const returned = hook(event);
    if (isThenable(returned)) returned.then(undefined, noop);
  } catch {
    // Ignored on purpose: see above.
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function noop(): void {
  // Nothing to do.
}
