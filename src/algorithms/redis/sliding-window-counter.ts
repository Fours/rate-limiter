import type { Algorithm } from '../../types.js';
import {
  createRedisAlgorithm,
  loadScript,
  type InternalRedisAlgorithmOptions,
  type RedisAlgorithmOptions,
} from './factory.js';

const script = loadScript('./sliding-window-counter.lua', import.meta.url);

/**
 * A sliding window counter in Redis: two counts per client, weighting the previous window by how
 * much of it still overlaps the last `windowMs`. Cheap like a fixed window, without its 2x burst at
 * every boundary, but an estimate rather than exact.
 */
export function createRedisSlidingWindowCounter(opts: RedisAlgorithmOptions): Algorithm {
  // Only the client is passed on: the public factory can never opt into app time (0007).
  return createRedisAlgorithm(script, 'createRedisSlidingWindowCounter', { client: opts.client });
}

/** For tests only: the same algorithm, driven by an injected clock. Not exported publicly. */
export function createRedisSlidingWindowCounterForTest(
  opts: InternalRedisAlgorithmOptions,
): Algorithm {
  return createRedisAlgorithm(script, 'createRedisSlidingWindowCounter', opts);
}
