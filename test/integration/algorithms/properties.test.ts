import { describe } from 'vitest';
import { createTokenBucket } from '../../../src/algorithms/token-bucket.js';
import type { Algorithm, Clock } from '../../../src/types.js';
import {
  describeAlgorithmProperties,
  describeModelComparison,
  type PropertyTraits,
  traits,
} from '../../contract/algorithm-properties.js';
import {
  fixedWindowModel,
  leakyBucketModel,
  slidingWindowCounterModel,
  slidingWindowLogModel,
} from '../../helpers/models.js';
import { useRedis, withoutExpiry } from '../helpers/algorithms.js';

// Property tests of the five scripts (decision 0034), without expiry: Redis expires keys in real
// time while these drive time with FakeClock (see withoutExpiry). Fewer runs than in memory, since
// each check is a round trip.
const r = useRedis();
const opts = { numRuns: 25, maxSteps: 60, timeout: 120_000 };

const scripts: [
  string,
  string,
  string,
  PropertyTraits,
  (clock: Clock) => Algorithm & { close?: () => void },
][] = [
  [
    'token bucket',
    'token-bucket.lua',
    'createRedisTokenBucket',
    traits.tokenBucket,
    (clock) => createTokenBucket({ clock }),
  ],
  [
    'fixed window',
    'fixed-window.lua',
    'createRedisFixedWindow',
    traits.fixedWindow,
    fixedWindowModel,
  ],
  [
    'sliding window log',
    'sliding-window-log.lua',
    'createRedisSlidingWindowLog',
    traits.slidingWindowLog,
    slidingWindowLogModel,
  ],
  [
    'sliding window counter',
    'sliding-window-counter.lua',
    'createRedisSlidingWindowCounter',
    traits.slidingWindowCounter,
    slidingWindowCounterModel,
  ],
  [
    'leaky bucket',
    'leaky-bucket.lua',
    'createRedisLeakyBucket',
    traits.leakyBucket,
    leakyBucketModel,
  ],
];

for (const [name, script, factory, t, reference] of scripts) {
  const setup = withoutExpiry(r, script, factory, t.supportsBurst);
  describe(`Redis ${name}`, () => {
    describeModelComparison(`Redis ${name}`, setup, reference, t.supportsBurst, {
      ...opts,
      numRuns: 100,
      maxSteps: 120,
    });
    describeAlgorithmProperties(`Redis ${name}`, setup, t, opts);
  });
}
