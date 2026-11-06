import { createHash } from 'node:crypto';
import type { Decision } from '../types.js';
import type { RedisScriptClient } from './client.js';

export interface LuaScript {
  readonly source: string;
  /** SHA-1 of the source: the same id Redis gives it, so there's no SCRIPT LOAD at startup. */
  readonly sha: string;
}

export function defineScript(source: string): LuaScript {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

/**
 * Runs a script by its SHA. If Redis no longer has it cached (after SCRIPT FLUSH, a restart or a
 * failover), runs it once with EVAL, which also caches it again. Exactly one retry, never a
 * loop, so a check stays bounded for the milestone 4 timeout. Any other error is rethrown as is.
 */
export async function runScript(
  client: RedisScriptClient,
  script: LuaScript,
  keys: string[],
  args: string[],
): Promise<unknown> {
  try {
    return await client.evalsha(script.sha, keys, args);
  } catch (err) {
    if (!isNoScript(err)) throw err;
    return client.eval(script.source, keys, args);
  }
}

/** The two clients use different error classes, but the message always starts with NOSCRIPT. */
function isNoScript(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('NOSCRIPT');
}

/**
 * Turns a script's `[allowed, remaining, resetMs]` reply into a Decision. Anything else throws
 * rather than becoming a wrong decision. A Lua nil inside the returned table silently shortens
 * the reply, which the length check catches.
 */
export function parseDecision(reply: unknown): Decision {
  if (!Array.isArray(reply) || reply.length !== 3 || !reply.every(isNonNegativeSafeInteger)) {
    throw new Error(
      `Unexpected reply from a rate-limit script: expected [allowed, remaining, resetMs] as ` +
        `non-negative integers, got ${describe(reply)}`,
    );
  }
  const [allowed, remaining, resetMs] = reply as [number, number, number];
  if (allowed !== 0 && allowed !== 1) {
    throw new Error(
      `Unexpected reply from a rate-limit script: allowed must be 0 or 1, got ${String(allowed)}`,
    );
  }
  return { allowed: allowed === 1, remaining, resetMs };
}

// Redis returns values near 2^53 off by one, so only safe integers can be trusted.
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function describe(value: unknown): string {
  try {
    // Typed as string, but JSON.stringify(undefined) returns undefined.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
