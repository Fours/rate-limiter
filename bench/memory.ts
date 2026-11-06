// Redis memory per key for each algorithm (milestone 3, T4; evidence for decision 0008).
//
//   npm run bench:memory    builds, then measures against REDIS_URL (default: the test Redis)
//
// For each algorithm and limit, it makes `limit` checks on one new key, then reads MEMORY USAGE
// and the key's encoding, and deletes the key. Rule ids are unique and nothing is flushed, since
// REDIS_URL might point at a Redis that isn't ours. No k6 and no stack: memory doesn't depend on
// load, only on what each script stores.
//
// It imports the package by name, as an app would: the built dist/ when run as a script, src/
// under Vitest (vitest.config.ts).
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import {
  buildKey,
  createRedisFixedWindow,
  createRedisLeakyBucket,
  createRedisSlidingWindowCounter,
  createRedisSlidingWindowLog,
  createRedisTokenBucket,
  fromIoredis,
  type Algorithm,
  type RedisAlgorithmOptions,
} from '@kylewillett/rate-limiter';
import { resultsDirName } from './records.ts';
import { baseSetup, ROOT } from './setup.ts';

const FACTORIES: readonly [string, (opts: RedisAlgorithmOptions) => Algorithm][] = [
  ['token-bucket', createRedisTokenBucket],
  ['leaky-bucket', createRedisLeakyBucket],
  ['fixed-window', createRedisFixedWindow],
  ['sliding-window-log', createRedisSlidingWindowLog],
  ['sliding-window-counter', createRedisSlidingWindowCounter],
];

/**
 * 10, 100 and 1,000 per minute are the spec's. 127 and 128 sit either side of Redis's default
 * `zset-max-listpack-entries` (128), where the sliding window log's sorted set changes encoding:
 * it holds one entry per allowed request plus its tag member, so a limit of 128 is 129 entries.
 */
export const LIMITS = [10, 100, 127, 128, 1000] as const;
const WINDOW_MS = 60_000;
/** The length of the README's example key, `rl:orders:free:key_3f2a9c1e5b7d4e8a`. */
export const KEY_LENGTH = 35;

export interface MemoryRow {
  readonly algorithm: string;
  readonly limit: number;
  /** MEMORY USAGE with SAMPLES 0, so nested values are counted exactly. */
  readonly bytes: number;
  /** OBJECT ENCODING, which explains the jumps: listpack is compact, skiplist isn't. */
  readonly encoding: string;
}

export async function measureMemory(
  redis: Redis,
  limits: readonly number[] = LIMITS,
): Promise<MemoryRow[]> {
  const rows: MemoryRow[] = [];
  for (const [algorithm, create] of FACTORIES) {
    const limiter = create({ client: fromIoredis(redis) });
    for (const limit of limits) {
      // MEMORY USAGE counts the key's name too, so every key is KEY_LENGTH bytes, like the
      // README's example, while staying unique: "m" plus 10 hex digits, and a hashed-key client.
      const rule = { id: `m${randomBytes(5).toString('hex')}`, limit, windowMs: WINDOW_MS };
      const key = buildKey(rule, `key_${randomBytes(8).toString('hex')}`);
      if (key.length !== KEY_LENGTH) throw new Error(`${key} is not ${String(KEY_LENGTH)} bytes`);
      // The leaky bucket allows only the first of these (no burst), but its state is one hash
      // whatever the limit, so this still measures what a busy client costs.
      for (let i = 0; i < limit; i++) await limiter.check(key, rule);
      const bytes = await redis.memory('USAGE', key, 'SAMPLES', 0);
      const encoding = await redis.object('ENCODING', key);
      await redis.del(key);
      if (bytes === null || typeof encoding !== 'string') {
        throw new Error(`${algorithm}: no key at ${key}`);
      }
      rows.push({ algorithm, limit, bytes, encoding });
    }
  }
  return rows;
}

/** One row per algorithm, one column per limit: `bytes (encoding)`. */
export function memoryTable(rows: readonly MemoryRow[]): string {
  const limits = [...new Set(rows.map((r) => r.limit))].sort((a, b) => a - b);
  const algorithms = [...new Set(rows.map((r) => r.algorithm))];
  const cell = (algorithm: string, limit: number) => {
    const row = rows.find((r) => r.algorithm === algorithm && r.limit === limit);
    return row === undefined ? '–' : `${row.bytes.toLocaleString('en-US')} (${row.encoding})`;
  };
  return [
    `| Algorithm | ${limits.map((l) => `${l.toLocaleString('en-US')} per minute`).join(' | ')} |`,
    `| --- | ${limits.map(() => '---').join(' | ')} |`,
    ...algorithms.map((a) => `| ${a} | ${limits.map((l) => cell(a, l)).join(' | ')} |`),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    const rows = await measureMemory(redis);
    const version = /redis_version:(\S+)/.exec(await redis.info('server'))?.[1] ?? 'unknown';
    // The encoding thresholds decide where memory jumps, so they're part of the result.
    const config = await redis.config('GET', '*-max-listpack-*');
    const thresholds = Object.fromEntries(
      config.flatMap((v, i, all) => (i % 2 === 0 ? [[v, all[i + 1]]] : [])),
    );

    const outRoot = join(ROOT, 'docs/decisions/data');
    await mkdir(outRoot, { recursive: true });
    const dir = join(outRoot, resultsDirName('memory', new Date(), await readdir(outRoot)));
    await mkdir(dir);
    const setup = {
      ...baseSetup('npm run bench:memory'),
      versions: { node: process.version, redis: version },
      redisConfig: thresholds,
      method: `limit checks on one new ${String(KEY_LENGTH)}-byte key per cell, then MEMORY USAGE key SAMPLES 0; windowMs ${String(WINDOW_MS)}`,
    };
    const table = memoryTable(rows);
    await writeFile(join(dir, 'setup.json'), `${JSON.stringify(setup, null, 2)}\n`);
    await writeFile(join(dir, 'memory.json'), `${JSON.stringify(rows, null, 2)}\n`);
    await writeFile(
      join(dir, 'memory.md'),
      `## Redis memory per key, in bytes\n\nRedis ${version}. Each cell: \`MEMORY USAGE\` after \`limit\` checks on one ${String(KEY_LENGTH)}-byte key, and its encoding.\n\n${table}`,
    );
    console.log(table);
    console.log(`Wrote ${join('docs/decisions/data', dir.split('/').pop() ?? '')}/`);
  } finally {
    redis.disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
