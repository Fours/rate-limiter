import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, measureMemory, memoryTable, type MemoryRow } from '../../../bench/memory.ts';
import { connectIoredis } from '../helpers/redis.js';

let redis: Redis;
let rows: MemoryRow[];

beforeAll(async () => {
  redis = await connectIoredis();
  rows = await measureMemory(redis);
});
afterAll(() => {
  redis.disconnect();
});

const bytes = (algorithm: string) =>
  LIMITS.map((limit) => rows.find((r) => r.algorithm === algorithm && r.limit === limit)?.bytes);

describe('measureMemory', () => {
  it('measures every algorithm at every limit', () => {
    expect(rows).toHaveLength(5 * LIMITS.length);
    for (const row of rows) {
      expect(row.bytes).toBeGreaterThan(0);
      expect(row.encoding).toMatch(/^(listpack|skiplist|hashtable)$/);
    }
  });

  it('shows the sliding window log growing with the limit', () => {
    const log = bytes('sliding-window-log') as number[];
    for (let i = 1; i < log.length; i++) expect(log[i]).toBeGreaterThan(log[i - 1] as number);
    // 100× the limit costs far more than 10× the memory: one entry per allowed request.
    expect(log.at(-1)).toBeGreaterThan(10 * (log[0] as number));
  });

  // Redis keeps a sorted set compact up to 128 entries. The log stores one per allowed request
  // plus its tag member, so it changes encoding between limits of 127 and 128.
  it('shows the log’s sorted set leaving the compact encoding above 128 entries', () => {
    const encodingAt = (limit: number) =>
      rows.find((r) => r.algorithm === 'sliding-window-log' && r.limit === limit)?.encoding;
    expect(encodingAt(127)).toBe('listpack');
    expect(encodingAt(128)).toBe('skiplist');
  });

  it('shows the sliding window counter staying the same size whatever the limit', () => {
    const counter = bytes('sliding-window-counter');
    expect(new Set(counter).size).toBe(1);
  });

  it('leaves no keys behind', async () => {
    // Other test files write keys too, so look only for ours: rule ids of "m" plus 10 hex digits.
    const ours = await redis.keys('rl:m??????????:key_*');
    expect(ours).toEqual([]);
  });
});

describe('memoryTable', () => {
  it('has one row per algorithm and one column per limit', () => {
    const table = memoryTable(rows).trim().split('\n');
    expect(table).toHaveLength(2 + 5);
    expect(table[0]).toBe(
      '| Algorithm | 10 per minute | 100 per minute | 127 per minute | 128 per minute | 1,000 per minute |',
    );
    expect(table.find((l) => l.startsWith('| sliding-window-log'))).toMatch(/\(skiplist\) \|$/);
  });
});
