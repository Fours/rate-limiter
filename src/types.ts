export interface Rule {
  /** Unique; used in the storage key, e.g. "orders:free". */
  readonly id: string;
  /** Max requests per window: the steady rate. Positive integer. */
  readonly limit: number;
  /** The window, in ms: `limit` requests per `windowMs`. Positive integer. */
  readonly windowMs: number;
  /**
   * How many requests can arrive at once, for algorithms that take one (`supportsBurst`): the
   * token bucket's capacity, by default `limit`, and the leaky bucket's tolerance, by default 1.
   * May be larger than `limit`. Positive integer (decision 0022).
   */
  readonly burst?: number;
  /**
   * Which algorithm checks this rule: a name from `rateLimit`'s `algorithms` option. The default
   * `algorithm` when absent (decision 0023).
   */
  readonly algorithm?: string;
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
  /**
   * Set by algorithms that honour `Rule.burst`. `rateLimit` refuses, at startup, a rule with a
   * burst for an algorithm without it, rather than ignore the burst (decision 0022).
   */
  readonly supportsBurst?: true;
}

export interface Clock {
  /** Epoch ms. */
  now(): number;
}
