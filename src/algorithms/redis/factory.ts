import { readFileSync } from 'node:fs';
import { assertScriptClient, type RedisScriptClient } from '../../redis/client.js';
import { defineScript, parseDecision, runScript, type LuaScript } from '../../redis/scripts.js';
import type { Algorithm, Clock } from '../../types.js';

export interface RedisAlgorithmOptions {
  /** A client from fromIoredis or fromNodeRedis, or your own RedisScriptClient. */
  readonly client: RedisScriptClient;
}

/**
 * Internal only, never exported from src/index.ts. `clock` makes scripts use app time instead of
 * Redis TIME, which production must never do (decision 0007). It exists so tests can drive
 * Redis algorithms with FakeClock.
 */
export interface InternalRedisAlgorithmOptions extends RedisAlgorithmOptions {
  readonly clock?: Clock;
}

// Shared helpers every algorithm script uses: the time source and the start-fresh check.
const prelude = readFileSync(new URL('./prelude.lua', import.meta.url), 'utf8');

/**
 * Reads a script that sits next to the calling module, in src/ and in dist/ alike, with the
 * prelude in front. The SHA covers both, so each check is still one script.
 */
export function loadScript(file: string, base: string): LuaScript {
  return defineScript(`${prelude}\n${readFileSync(new URL(file, base), 'utf8')}`);
}

export function createRedisAlgorithm(
  script: LuaScript,
  name: string,
  opts: InternalRedisAlgorithmOptions,
  supportsBurst = false,
): Algorithm {
  assertScriptClient(opts.client, name);
  const { client, clock } = opts;
  return {
    ...(supportsBurst ? { supportsBurst: true as const } : {}),
    async check(key, rule) {
      const now = clock === undefined ? '' : String(clock.now());
      const reply = await runScript(
        client,
        script,
        [key],
        [String(rule.limit), String(rule.windowMs), now, String(rule.burst ?? '')],
      );
      return parseDecision(reply);
    },
  };
}
