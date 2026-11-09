import type { Algorithm } from '../../types.js';
import {
  createRedisAlgorithm,
  type InternalRedisAlgorithmOptions,
  type RedisAlgorithmOptions,
} from './factory.js';
import { loadScript } from './load-script.js';

const script = loadScript('./token-bucket.lua', import.meta.url);

/**
 * A token bucket in Redis, shared by every app instance that uses the same Redis. Up to `burst`
 * requests at once (`limit` by default), refilling `limit` per `windowMs`. Each check is one atomic script that uses
 * Redis time (decisions 0006 and 0007).
 */
export function createRedisTokenBucket(opts: RedisAlgorithmOptions): Algorithm {
  // Only the client is passed on: the public factory can never opt into app time.
  return createRedisAlgorithm(script, 'createRedisTokenBucket', { client: opts.client }, true);
}

/** For tests only: the same algorithm, driven by an injected clock. Not exported publicly. */
export function createRedisTokenBucketForTest(opts: InternalRedisAlgorithmOptions): Algorithm {
  return createRedisAlgorithm(script, 'createRedisTokenBucket', opts, true);
}
