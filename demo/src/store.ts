// Starts the demo's "Redis": the stand-in, a Lua engine, and the five algorithms over them.
// The engine's .wasm comes from this site, through Vite, never from a CDN (decision 0024).
import wasmUrl from 'wasmoon/dist/glue.wasm?url';
import type { Algorithm } from '../../src/types.ts';
import { createScriptRunner, standInClient } from './redis/lua.ts';
import { createAlgorithms, type AlgorithmName } from './redis/scripts.ts';
import { StandInRedis } from './redis/stand-in.ts';

export interface DemoStore {
  readonly redis: StandInRedis;
  readonly algorithms: Record<AlgorithmName, Algorithm>;
}

export async function startStore(now: () => number): Promise<DemoStore> {
  const redis = new StandInRedis(now);
  const runner = await createScriptRunner(redis, wasmUrl);
  const algorithms = await createAlgorithms(standInClient(redis, runner));
  return { redis, algorithms };
}
