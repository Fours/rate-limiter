import { createRedisFixedWindowForTest } from '../../src/algorithms/redis/fixed-window.js';
import { createRedisLeakyBucketForTest } from '../../src/algorithms/redis/leaky-bucket.js';
import { createRedisSlidingWindowCounterForTest } from '../../src/algorithms/redis/sliding-window-counter.js';
import { createRedisSlidingWindowLogForTest } from '../../src/algorithms/redis/sliding-window-log.js';
import { createRedisTokenBucketForTest } from '../../src/algorithms/redis/token-bucket.js';
import { describeMiddleware } from '../contract/middleware-contract.js';
import { useRedis, withFakeClock } from './helpers/algorithms.js';

// The milestone 1 middleware behaviours against every Redis algorithm, with src/middleware.ts
// unchanged: the evidence decision 0001 promised.
const r = useRedis();
const bursty = { burst: (rule: { limit: number }) => rule.limit };

describeMiddleware('Redis token bucket', withFakeClock(r, createRedisTokenBucketForTest), bursty);
describeMiddleware('Redis fixed window', withFakeClock(r, createRedisFixedWindowForTest), bursty);
describeMiddleware(
  'Redis sliding window log',
  withFakeClock(r, createRedisSlidingWindowLogForTest),
  bursty,
);
describeMiddleware(
  'Redis sliding window counter',
  withFakeClock(r, createRedisSlidingWindowCounterForTest),
  bursty,
);
describeMiddleware('Redis leaky bucket', withFakeClock(r, createRedisLeakyBucketForTest), {
  burst: (rule) => Math.ceil(rule.limit / rule.windowMs),
});
