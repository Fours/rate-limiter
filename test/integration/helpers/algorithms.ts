import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  createRedisAlgorithm,
  type InternalRedisAlgorithmOptions,
} from '../../../src/algorithms/redis/factory.js';
import { buildKey } from '../../../src/identify.js';
import { fromIoredis, type RedisScriptClient } from '../../../src/redis/client.js';
import { defineScript } from '../../../src/redis/scripts.js';
import type { Algorithm, Decision, Rule } from '../../../src/types.js';
import type { AlgorithmUnderTest } from '../../contract/algorithm-contract.js';
import { FakeClock } from '../../helpers/fake-clock.js';
import { connectIoredis, uniqueRuleId } from './redis.js';

export interface RedisHandle {
  readonly redis: Redis;
  readonly client: RedisScriptClient;
}

/** One ioredis connection for the test file, opened before its tests and closed after. */
export function useRedis(): RedisHandle {
  let redis: Redis | undefined;
  let client: RedisScriptClient | undefined;
  beforeAll(async () => {
    redis = await connectIoredis();
    client = fromIoredis(redis);
  });
  afterAll(async () => {
    await redis?.quit();
  });
  const ready = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('useRedis: used before beforeAll ran');
    return value;
  };
  return {
    get redis() {
      return ready(redis);
    },
    get client() {
      return ready(client);
    },
  };
}

/** A Redis algorithm driven by a fresh FakeClock, for the behaviour suite and other tests. */
export function withFakeClock(
  handle: RedisHandle,
  create: (opts: InternalRedisAlgorithmOptions) => Algorithm,
): () => AlgorithmUnderTest {
  return () => {
    const clock = new FakeClock();
    return { algorithm: create({ client: handle.client, clock }), clock };
  };
}

/**
 * A Redis algorithm from a copy of its script with the PEXPIRE removed, driven by a fresh
 * FakeClock. For comparisons against a model with no expiry: the time is fake, but Redis expires
 * keys in real time, and a TTL of a few ms can run out between two checks in the same fake ms,
 * which starts the client fresh. That happened in CI. Expiry has tests of its own, which check
 * that a kept key and an expired one give the same answer.
 */
export function withoutExpiry(
  handle: RedisHandle,
  script: string,
  name: string,
  supportsBurst = false,
): () => AlgorithmUnderTest {
  const read = (file: string) =>
    readFileSync(new URL(`../../../src/algorithms/redis/${file}`, import.meta.url), 'utf8');
  const source = read(script);
  const stripped = source.replace(/^redis\.call\('PEXPIRE'.*$/m, '');
  if (stripped === source) throw new Error(`withoutExpiry: no PEXPIRE line in ${script}`);
  // As loadScript builds it: the prelude, then the script.
  const lua = defineScript(`${read('prelude.lua')}\n${stripped}`);
  return () => {
    const clock = new FakeClock();
    return {
      algorithm: createRedisAlgorithm(lua, name, { client: handle.client, clock }, supportsBurst),
      clock,
    };
  };
}

/** [ms to advance (negative: the clock steps back), rule, client] */
export type Step = [number, Rule, string];

/**
 * A fixed sequence for comparing an algorithm against a reference, step for step: uneven gaps,
 * two clients, a clock that steps back and returns, limit and window changes, and the
 * 48-per-day rule where float maths lands on 0.999… tokens.
 */
export function comparisonSteps(): Step[] {
  const id = uniqueRuleId('compare');
  const base: Rule = { id, limit: 5, windowMs: 60_000 };
  const daily: Rule = { id: `${id}:daily`, limit: 48, windowMs: 86_400_000 };
  const steps: Step[] = [];
  const gaps = [0, 0, 0, 0, 0, 0, 1, 11_999, 1, 7, 13, 30_001, 0, 2, 59_999, 60_000, 5];
  for (const gap of gaps) steps.push([gap, base, 'a'], [0, base, 'b']);
  steps.push([-3_600_000, base, 'a'], [0, base, 'a'], [3_600_000, base, 'a']);
  steps.push([0, { ...base, limit: 9 }, 'a'], [4_321, { ...base, limit: 9 }, 'a']);
  steps.push([0, { ...base, limit: 2 }, 'a'], [0, { ...base, limit: 2 }, 'a']);
  steps.push(
    [0, { ...base, windowMs: 120_000 }, 'b'],
    [17_777, { ...base, windowMs: 120_000 }, 'b'],
  );
  for (const gap of [0, 0, 1_799_999, 1, 1_800_000, 0, 1]) steps.push([gap, daily, 'a']);
  return steps;
}

/**
 * Like comparisonSteps, with bursts (decision 0022): below the limit, above it, at an interval
 * that isn't a whole number of ms, raised and cut under a stored key, alongside limit and window
 * changes, removed again, and with the clock stepping back.
 */
export function burstSteps(): Step[] {
  const id = uniqueRuleId('burst');
  const base: Rule = { id, limit: 5, windowMs: 60_000, burst: 2 };
  const wide: Rule = { id: `${id}:wide`, limit: 5, windowMs: 60_000, burst: 12 };
  const odd: Rule = { id: `${id}:odd`, limit: 7, windowMs: 60_000, burst: 3 };
  const daily: Rule = { id: `${id}:daily`, limit: 48, windowMs: 86_400_000, burst: 5 };
  const steps: Step[] = [];
  for (const gap of [0, 0, 0, 1, 11_999, 1, 0, 12_000, 0, 0, 36_000, 0, 0, 0]) {
    steps.push([gap, base, 'a'], [0, base, 'b']);
  }
  for (const gap of [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5_000, 0, 24_000, 0, 0, 0, 0]) {
    steps.push([gap, wide, 'c']);
  }
  for (const gap of [0, 0, 0, 0, 8_571, 0, 1, 0, 17_143, 0, 0, 0]) steps.push([gap, odd, 'd']);
  // The burst raised, then cut, under a stored key; then a limit and a window change with it.
  steps.push([0, { ...base, burst: 8 }, 'a'], [0, { ...base, burst: 8 }, 'a']);
  steps.push([0, { ...base, burst: 8 }, 'a'], [3_000, { ...base, burst: 3 }, 'a']);
  steps.push([0, { ...base, burst: 3 }, 'a'], [0, { ...base, burst: 1 }, 'a']);
  steps.push(
    [0, { ...base, limit: 9, burst: 4 }, 'a'],
    [4_321, { ...base, limit: 9, burst: 4 }, 'a'],
  );
  steps.push(
    [0, { ...base, windowMs: 120_000 }, 'b'],
    [17_777, { ...base, windowMs: 120_000 }, 'b'],
  );
  // The burst removed again, and the clock stepping back and returning.
  const plain: Rule = { id, limit: base.limit, windowMs: base.windowMs };
  steps.push([0, plain, 'a'], [0, plain, 'a'], [-3_600_000, base, 'a'], [3_600_000, base, 'a']);
  for (const gap of [0, 0, 0, 0, 0, 0, 1_799_999, 1, 1_800_000, 0, 1])
    steps.push([gap, daily, 'e']);
  return steps;
}

export async function runSteps(
  algorithm: Algorithm,
  clock: FakeClock,
  steps: Step[],
): Promise<Decision[]> {
  const out: Decision[] = [];
  for (const [gap, rule, who] of steps) {
    clock.set(clock.now() + gap);
    out.push(await algorithm.check(buildKey(rule, who), rule));
  }
  return out;
}

export async function expectTtlNear(redis: Redis, key: string, ms: number): Promise<void> {
  const ttl = await redis.pttl(key);
  // Real time passes between the check and PTTL; allow for a slow CI machine.
  expect(ttl).toBeLessThanOrEqual(ms);
  expect(ttl).toBeGreaterThan(ms - 1_000);
}
