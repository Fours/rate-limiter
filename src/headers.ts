import type { Decision, Rule } from './types.js';

export interface RateLimitHeaders {
  readonly 'RateLimit-Limit': string;
  readonly 'RateLimit-Remaining': string;
  readonly 'RateLimit-Reset': string;
}

/** The headers set on every limited request, allowed or denied (decision 0012). */
export function rateLimitHeaders(rule: Rule, decision: Decision): RateLimitHeaders {
  return {
    'RateLimit-Limit': String(rule.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(msToSeconds(decision.resetMs)),
  };
}

/**
 * `Retry-After` for a denied request. Never below 1: "0" would tell a denied
 * client to retry at once, so it would hammer the server (decision 0012).
 */
export function retryAfter(decision: Decision): string {
  return String(Math.max(1, msToSeconds(decision.resetMs)));
}

/**
 * Rounds up, so a client that waits the advertised seconds is never early.
 * Express writes numbers to headers unrounded, so the rounding has to happen here.
 */
function msToSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}
