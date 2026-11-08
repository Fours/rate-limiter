import type { Algorithm } from '../types.js';

/**
 * Internal, not exported from the package. Marks an algorithm whose default burst isn't
 * `limit`, so the fallback, a token bucket, can keep it during an outage. The leaky bucket's
 * default is 1, no burst at all (decision 0022), and a fallback that read a missing burst as
 * `limit` let a rule meant to smooth traffic take its whole limit at once.
 */
const DEFAULT_BURST = Symbol('rate-limiter.default-burst');

export function withDefaultBurst(algorithm: Algorithm, burst: number): Algorithm {
  return Object.defineProperty(algorithm, DEFAULT_BURST, { value: burst });
}

/** The burst `algorithm` would use for a rule without one, if it isn't `limit`. */
export function defaultBurstOf(algorithm: Algorithm): number | undefined {
  const value = (algorithm as Algorithm & { [DEFAULT_BURST]?: unknown })[DEFAULT_BURST];
  return typeof value === 'number' ? value : undefined;
}
