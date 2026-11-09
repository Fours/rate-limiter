import type { Algorithm } from '../../types.js';
import {
  createRedisAlgorithm,
  type InternalRedisAlgorithmOptions,
  type RedisAlgorithmOptions,
} from './factory.js';
import { loadScript } from './load-script.js';

const script = loadScript('./fixed-window.lua', import.meta.url);

/**
 * A fixed window in Redis: up to `limit` requests per `windowMs`, with windows aligned to the
 * epoch. Simple and cheap, but a client can get up to 2x the limit across a window boundary.
 */
export function createRedisFixedWindow(opts: RedisAlgorithmOptions): Algorithm {
  // Only the client is passed on: the public factory can never opt into app time (0007).
  return createRedisAlgorithm(script, 'createRedisFixedWindow', { client: opts.client });
}

/** For tests only: the same algorithm, driven by an injected clock. Not exported publicly. */
export function createRedisFixedWindowForTest(opts: InternalRedisAlgorithmOptions): Algorithm {
  return createRedisAlgorithm(script, 'createRedisFixedWindow', opts);
}
