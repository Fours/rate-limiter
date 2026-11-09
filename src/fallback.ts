import { defaultBurstOf } from './algorithms/default-burst.js';
import { createTokenBucket, type TokenBucket } from './algorithms/token-bucket.js';
import type { Algorithm, Clock, Decision, Rule } from './types.js';

/**
 * Each instance's share of a rule during an outage (decision 0010). Round robin spreads a client
 * over the instances, so the shares add up to about `limit`, and a burst is shared the same way
 * (decision 0022). Never below 1, so a rule with fewer requests than instances still lets
 * something through.
 */
export function scaleRule(rule: Rule, instances: number): Rule {
  if (instances === 1) return rule;
  const share = (n: number) => Math.max(1, Math.ceil(n / instances));
  return {
    ...rule,
    limit: share(rule.limit),
    ...(rule.burst === undefined ? {} : { burst: share(rule.burst) }),
  };
}

/**
 * The rule the fallback checks in place of `rule` while `algorithm` is failing. The fallback is a
 * token bucket, whose default burst is `limit`, so an algorithm with another default (the leaky
 * bucket's is 1, decision 0022) passes it on: a rule meant to smooth traffic doesn't take its
 * whole limit at once during an outage. Unchanged otherwise.
 */
export function fallbackRule(rule: Rule, algorithm: Algorithm): Rule {
  const burst = defaultBurstOf(algorithm);
  return rule.burst === undefined && burst !== undefined ? { ...rule, burst } : rule;
}

export interface Fallback {
  /** Checks against the scaled rule, which it returns so headers can report the scaled limit. */
  check(key: string, rule: Rule): Promise<{ rule: Rule; decision: Decision }>;
  close(): void;
}

/**
 * The in-memory token bucket used while the primary algorithm is failing (decision 0018). It's
 * created on the first failure, so a limiter whose Redis never fails holds no second bucket and
 * no second sweep timer.
 */
export function createFallback(instances: number, clock?: Clock): Fallback {
  let bucket: TokenBucket | undefined;
  let closed = false;

  return {
    async check(key, rule) {
      if (bucket === undefined) {
        bucket = createTokenBucket(clock === undefined ? {} : { clock });
        // Still answers after close(), like the bucket itself, but without a timer running.
        if (closed) bucket.close();
      }
      const scaled = scaleRule(rule, instances);
      return { rule: scaled, decision: await bucket.check(key, scaled) };
    },
    close() {
      closed = true;
      bucket?.close();
    },
  };
}
