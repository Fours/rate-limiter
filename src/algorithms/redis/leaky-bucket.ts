import type { Algorithm } from '../../types.js';
import {
  createRedisAlgorithm,
  loadScript,
  type InternalRedisAlgorithmOptions,
  type RedisAlgorithmOptions,
} from './factory.js';

const script = loadScript('./leaky-bucket.lua', import.meta.url);

/**
 * A leaky bucket in Redis, as a burst-free GCRA (decision 0014): one request per
 * `windowMs / limit`, evenly spaced, with no burst. `limit: 10, windowMs: 60_000` means one
 * request every 6 s, not 10 at once.
 */
export function createRedisLeakyBucket(opts: RedisAlgorithmOptions): Algorithm {
  // Only the client is passed on: the public factory can never opt into app time (0007).
  return createRedisAlgorithm(script, 'createRedisLeakyBucket', { client: opts.client }, true);
}

/** For tests only: the same algorithm, driven by an injected clock. Not exported publicly. */
export function createRedisLeakyBucketForTest(opts: InternalRedisAlgorithmOptions): Algorithm {
  return createRedisAlgorithm(script, 'createRedisLeakyBucket', opts, true);
}
