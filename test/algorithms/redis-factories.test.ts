import { describe, expect, it } from 'vitest';
import {
  createRedisFixedWindow,
  createRedisFixedWindowForTest,
} from '../../src/algorithms/redis/fixed-window.js';
import {
  createRedisLeakyBucket,
  createRedisLeakyBucketForTest,
} from '../../src/algorithms/redis/leaky-bucket.js';
import {
  createRedisSlidingWindowCounter,
  createRedisSlidingWindowCounterForTest,
} from '../../src/algorithms/redis/sliding-window-counter.js';
import {
  createRedisSlidingWindowLog,
  createRedisSlidingWindowLogForTest,
} from '../../src/algorithms/redis/sliding-window-log.js';
import {
  createRedisTokenBucket,
  createRedisTokenBucketForTest,
} from '../../src/algorithms/redis/token-bucket.js';
import type { RedisScriptClient } from '../../src/redis/client.js';
import type { Algorithm } from '../../src/types.js';

// The Redis factories without a Redis: what each checks and declares at startup. Found by
// mutation testing: no test checked the name in each one's error, or the test-only factories'
// burst support.
const client: RedisScriptClient = {
  evalsha: () => Promise.resolve([1, 0, 0]),
  eval: () => Promise.resolve([1, 0, 0]),
};

type Factory = (opts: { client: RedisScriptClient }) => Algorithm;
const factories: [string, Factory, Factory, boolean][] = [
  ['createRedisTokenBucket', createRedisTokenBucket, createRedisTokenBucketForTest, true],
  ['createRedisLeakyBucket', createRedisLeakyBucket, createRedisLeakyBucketForTest, true],
  ['createRedisFixedWindow', createRedisFixedWindow, createRedisFixedWindowForTest, false],
  [
    'createRedisSlidingWindowLog',
    createRedisSlidingWindowLog,
    createRedisSlidingWindowLogForTest,
    false,
  ],
  [
    'createRedisSlidingWindowCounter',
    createRedisSlidingWindowCounter,
    createRedisSlidingWindowCounterForTest,
    false,
  ],
];

describe.each(factories)('%s', (name, make, makeForTest, bursts) => {
  it('names itself when the client is wrong', () => {
    expect(() => make({ client: {} as RedisScriptClient })).toThrow(new RegExp(`^${name}: `));
    expect(() => makeForTest({ client: {} as RedisScriptClient })).toThrow(
      new RegExp(`^${name}: `),
    );
  });

  it(bursts ? 'takes a burst, in both factories' : 'takes no burst', () => {
    expect(make({ client }).supportsBurst === true).toBe(bursts);
    expect(makeForTest({ client }).supportsBurst === true).toBe(bursts);
  });
});
