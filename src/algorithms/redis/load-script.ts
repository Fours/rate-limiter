// The Node-only half of the Redis algorithms: reading the Lua and hashing it. Kept apart from
// factory.ts and redis/scripts.ts so those run in a browser too (decision 0024).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LuaScript } from '../../redis/scripts.js';

export function defineScript(source: string): LuaScript {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
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
