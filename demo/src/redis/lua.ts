// Runs the rate-limit scripts in wasmoon (Lua 5.4 in WebAssembly) against the stand-in, and
// gives the library a RedisScriptClient for it, so the demo's checks go through the same
// runScript, NOSCRIPT retry and reply parsing as production (decision 0024).
import { LuaFactory, type LuaEngine } from 'wasmoon';
import type { RedisScriptClient } from '../../../src/redis/client.ts';
import { RedisError, type CommandReply, type StandInRedis } from './stand-in.ts';

/** Redis's SHA-1 of a script, as EVALSHA names it, computed with Web Crypto. */
export async function scriptSha(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Redis turns a Lua number in a script's reply into an integer by truncating it.
function toReply(value: unknown): unknown {
  if (typeof value === 'number') return Math.trunc(value);
  if (Array.isArray(value)) return value.map(toReply);
  return value;
}

/** A Lua engine set up to run scripts against one stand-in Redis. */
export interface ScriptRunner {
  /** Runs a script's source with KEYS and ARGV set, as EVAL does, and returns its reply. */
  run(source: string, keys: string[], args: string[]): unknown;
  close(): void;
}

/**
 * @param wasmUrl where to load wasmoon's glue.wasm from. In a browser, pass Vite's URL for it:
 *   without one, wasmoon fetches it from a CDN. Node finds it next to wasmoon's own module.
 */
export async function createScriptRunner(
  redis: StandInRedis,
  wasmUrl?: string,
): Promise<ScriptRunner> {
  const engine: LuaEngine = await new LuaFactory(wasmUrl).createEngine();
  engine.global.set('__redis_call', (name: string, ...args: unknown[]): CommandReply => {
    return redis.call(name, ...args);
  });
  // The scripts only use redis.call. A failed command raises a Lua error that ends the script,
  // as in Redis.
  await engine.doString('redis = { call = function(...) return __redis_call(...) end }');
  return {
    run(source, keys, args) {
      engine.global.set('KEYS', keys);
      engine.global.set('ARGV', args);
      return toReply(engine.doStringSync(source));
    },
    close() {
      engine.global.close();
    },
  };
}

/**
 * A RedisScriptClient for the stand-in. With `dryRun`, every script's changes are undone as soon
 * as it ends. EVALSHA finds only scripts EVAL has cached, and rejects
 * with NOSCRIPT otherwise, so runScript's retry runs as it would after a Redis restart. A script
 * runs within one call, with nothing awaited, so no other check can interleave: atomic, as in Redis.
 */
export function standInClient(
  redis: StandInRedis,
  runner: ScriptRunner,
  opts: { dryRun?: boolean } = {},
): RedisScriptClient {
  const execute = (source: string, keys: string[], args: string[]): unknown => {
    if (redis.down) throw new RedisError('ERR the stand-in Redis is down');
    if (opts.dryRun !== true) return runner.run(source, keys, args);
    // A dry run: the script runs on the real state, which is put back before anything else can
    // run, since nothing here awaits. So the demo can show what a check would say right now,
    // from the shipped script itself, without spending anything.
    const before = redis.snapshot();
    try {
      return runner.run(source, keys, args);
    } finally {
      redis.restore(before);
    }
  };
  return {
    evalsha(sha, keys, args) {
      try {
        const source = redis.down ? undefined : redis.scripts.get(sha);
        if (!redis.down && source === undefined) {
          throw new RedisError('NOSCRIPT No matching script. Please use EVAL.');
        }
        return Promise.resolve(execute(source ?? '', keys, args));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
    async eval(source, keys, args) {
      const sha = await scriptSha(source);
      if (redis.down) throw new RedisError('ERR the stand-in Redis is down');
      redis.scripts.set(sha, source);
      return execute(source, keys, args);
    },
  };
}
