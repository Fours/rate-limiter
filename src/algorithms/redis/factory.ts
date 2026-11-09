import { assertScriptClient, type RedisScriptClient } from '../../redis/client.js';
import { parseDecision, runScript, type LuaScript } from '../../redis/scripts.js';
import type { Algorithm, Clock } from '../../types.js';

// No Node modules here or in redis/scripts.ts: the demo runs this same wrapper in the browser
// (decision 0024). Reading files and hashing live in load-script.ts.

/** Options for the five Redis algorithm factories, such as {@link createRedisTokenBucket}. */
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
