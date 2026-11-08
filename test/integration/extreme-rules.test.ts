import { describe, expect, it } from 'vitest';
import { createRedisFixedWindowForTest } from '../../src/algorithms/redis/fixed-window.js';
import { createRedisLeakyBucketForTest } from '../../src/algorithms/redis/leaky-bucket.js';
import { createRedisSlidingWindowCounterForTest } from '../../src/algorithms/redis/sliding-window-counter.js';
import { createRedisSlidingWindowLogForTest } from '../../src/algorithms/redis/sliding-window-log.js';
import { createRedisTokenBucketForTest } from '../../src/algorithms/redis/token-bucket.js';
import { buildKey } from '../../src/identify.js';
import { validateRules } from '../../src/rules.js';
import type { Rule } from '../../src/types.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { useRedis } from './helpers/algorithms.js';
import { uniqueRuleId } from './helpers/redis.js';

// Found by the 1.0 correctness review: rules that passed validation, such as
// { limit: 1, windowMs: Number.MAX_SAFE_INTEGER }, made four scripts reply with times past 2^53,
// which the reply check rejects, so every check failed at request time. Validation now stops at
// 2^51, and each script must answer every rule up to it.
const r = useRedis();
const EDGE = 2 ** 51;

const factories = {
  'token bucket': createRedisTokenBucketForTest,
  'leaky bucket': createRedisLeakyBucketForTest,
  'fixed window': createRedisFixedWindowForTest,
  'sliding window log': createRedisSlidingWindowLogForTest,
  'sliding window counter': createRedisSlidingWindowCounterForTest,
};
const bursting = new Set(['token bucket', 'leaky bucket']);

const shapes: Omit<Rule, 'id'>[] = [
  { limit: 1, windowMs: EDGE },
  { limit: EDGE, windowMs: 1 },
  { limit: 3, windowMs: Math.floor(EDGE / 3) },
  { limit: 1, windowMs: 1, burst: EDGE },
  { limit: 2, windowMs: 2 ** 50, burst: 2 },
];

describe('rules at the validation bound (2^51)', () => {
  for (const [name, make] of Object.entries(factories)) {
    for (const shape of shapes) {
      if (shape.burst !== undefined && !bursting.has(name)) continue;
      it(`${name} answers ${JSON.stringify(shape)}`, async () => {
        const rule: Rule = { id: uniqueRuleId('edge'), ...shape };
        validateRules([rule]);
        const clock = new FakeClock();
        const algorithm = make({ client: r.client, clock });
        const key = buildKey(rule, 'c');
        const first = await algorithm.check(key, rule);
        expect(first.allowed).toBe(true);
        for (let i = 0; i < 3; i++) {
          clock.advance(1);
          const next = await algorithm.check(key, rule);
          expect(Number.isSafeInteger(next.resetMs)).toBe(true);
          expect(Number.isSafeInteger(next.remaining)).toBe(true);
        }
        clock.advance(2 ** 50);
        expect(Number.isSafeInteger((await algorithm.check(key, rule)).resetMs)).toBe(true);
      });
    }
  }
});
