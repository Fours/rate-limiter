/// <reference types="vite/client" />
// The five shipped scripts, read from src/ as text and put together the way loadScript does, so
// the demo runs exactly what the package runs (decision 0024). Nothing here copies their logic.
import { withDefaultBurst } from '../../../src/algorithms/default-burst.ts';
import { createRedisAlgorithm } from '../../../src/algorithms/redis/factory.ts';
import fixedWindow from '../../../src/algorithms/redis/fixed-window.lua?raw';
import leakyBucket from '../../../src/algorithms/redis/leaky-bucket.lua?raw';
import prelude from '../../../src/algorithms/redis/prelude.lua?raw';
import slidingWindowCounter from '../../../src/algorithms/redis/sliding-window-counter.lua?raw';
import slidingWindowLog from '../../../src/algorithms/redis/sliding-window-log.lua?raw';
import tokenBucket from '../../../src/algorithms/redis/token-bucket.lua?raw';
import type { RedisScriptClient } from '../../../src/redis/client.ts';
import type { LuaScript } from '../../../src/redis/scripts.ts';
import type { Algorithm } from '../../../src/types.ts';
import { scriptSha } from './lua.ts';

export const ALGORITHMS = [
  'token-bucket',
  'leaky-bucket',
  'fixed-window',
  'sliding-window-log',
  'sliding-window-counter',
] as const;

export type AlgorithmName = (typeof ALGORITHMS)[number];

const files: Record<AlgorithmName, string> = {
  'token-bucket': tokenBucket,
  'leaky-bucket': leakyBucket,
  'fixed-window': fixedWindow,
  'sliding-window-log': slidingWindowLog,
  'sliding-window-counter': slidingWindowCounter,
};

/** Each script as Redis receives it: the prelude, a newline, then the algorithm's file. */
export const SCRIPT_SOURCES = Object.fromEntries(
  ALGORITHMS.map((name) => [name, `${prelude}\n${files[name]}`]),
) as Record<AlgorithmName, string>;

// The names the package's factories pass, which appear in their errors, and which take a burst.
const factoryNames: Record<AlgorithmName, string> = {
  'token-bucket': 'createRedisTokenBucket',
  'leaky-bucket': 'createRedisLeakyBucket',
  'fixed-window': 'createRedisFixedWindow',
  'sliding-window-log': 'createRedisSlidingWindowLog',
  'sliding-window-counter': 'createRedisSlidingWindowCounter',
};
const SUPPORTS_BURST: ReadonlySet<AlgorithmName> = new Set(['token-bucket', 'leaky-bucket']);

/** The five algorithms over `client`, built by the package's own wrapper, as its factories do. */
export async function createAlgorithms(
  client: RedisScriptClient,
): Promise<Record<AlgorithmName, Algorithm>> {
  const entries = await Promise.all(
    ALGORITHMS.map(async (name) => {
      const source = SCRIPT_SOURCES[name];
      const script: LuaScript = { source, sha: await scriptSha(source) };
      const algorithm = createRedisAlgorithm(
        script,
        factoryNames[name],
        { client },
        SUPPORTS_BURST.has(name),
      );
      // As createRedisLeakyBucket does, so the fallback keeps the leaky bucket's burst of 1.
      return [name, name === 'leaky-bucket' ? withDefaultBurst(algorithm, 1) : algorithm] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<AlgorithmName, Algorithm>;
}
