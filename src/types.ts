export interface Rule {
  /** Unique; used in the storage key, e.g. "orders:free". */
  readonly id: string;
  /** Max requests per window (bucket capacity). Positive integer. */
  readonly limit: number;
  /** Time to refill a full bucket, in ms. Positive integer. */
  readonly windowMs: number;
  /** e.g. "POST". Matches any method when absent. */
  readonly method?: string;
  /** Exact "/orders" or prefix "/orders/*". Matches any path when absent. */
  readonly path?: string;
  /** e.g. "free". Matches any tier when absent. */
  readonly tier?: string;
}

export interface Decision {
  readonly allowed: boolean;
  /** Whole requests left right now, >= 0. */
  readonly remaining: number;
  /** When allowed: ms until the limit is fully restored. When denied: ms until the next request would be allowed. */
  readonly resetMs: number;
}

/**
 * Async even for in-memory algorithms so Redis-backed ones plug in unchanged
 * (decision 0001). Stores and clocks are supplied at construction, never here.
 */
export interface Algorithm {
  check(key: string, rule: Rule): Promise<Decision>;
}

export interface Clock {
  /** Epoch ms. */
  now(): number;
}
