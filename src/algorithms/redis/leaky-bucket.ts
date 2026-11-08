import type { Algorithm } from '../../types.js';
import { withDefaultBurst } from '../default-burst.js';
import {
  createRedisAlgorithm,
  loadScript,
  type InternalRedisAlgorithmOptions,
  type RedisAlgorithmOptions,
} from './factory.js';

const script = loadScript('./leaky-bucket.lua', import.meta.url);

/**
 * A leaky bucket in Redis, as a GCRA (decision 0014): one request per `windowMs / limit`, evenly
 * spaced. `limit: 10, windowMs: 60_000` means one request every 6 s, not 10 at once. A rule's
 * `burst` lets that many through at once from idle; without one there's no burst (0022).
 */
export function createRedisLeakyBucket(opts: RedisAlgorithmOptions): Algorithm {
  // Only the client is passed on: the public factory can never opt into app time (0007).
  return withDefaultBurst(
    createRedisAlgorithm(script, 'createRedisLeakyBucket', { client: opts.client }, true),
    1,
  );
}

/** For tests only: the same algorithm, driven by an injected clock. Not exported publicly. */
export function createRedisLeakyBucketForTest(opts: InternalRedisAlgorithmOptions): Algorithm {
  return withDefaultBurst(createRedisAlgorithm(script, 'createRedisLeakyBucket', opts, true), 1);
}
