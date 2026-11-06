import type { Algorithm } from '../../types.js';
import {
  createRedisAlgorithm,
  loadScript,
  type InternalRedisAlgorithmOptions,
  type RedisAlgorithmOptions,
} from './factory.js';

const script = loadScript('./sliding-window-log.lua', import.meta.url);

/**
 * A sliding window log in Redis: exactly `limit` requests in any `windowMs`, with no burst at
 * window boundaries. Exact, but it stores one entry per allowed request, up to `limit` per client.
 */
export function createRedisSlidingWindowLog(opts: RedisAlgorithmOptions): Algorithm {
  // Only the client is passed on: the public factory can never opt into app time (0007).
  return createRedisAlgorithm(script, 'createRedisSlidingWindowLog', { client: opts.client });
}

/** For tests only: the same algorithm, driven by an injected clock. Not exported publicly. */
export function createRedisSlidingWindowLogForTest(opts: InternalRedisAlgorithmOptions): Algorithm {
  return createRedisAlgorithm(script, 'createRedisSlidingWindowLog', opts);
}
