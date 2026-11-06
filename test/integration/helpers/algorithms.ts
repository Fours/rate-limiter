import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect } from 'vitest';
import type { InternalRedisAlgorithmOptions } from '../../../src/algorithms/redis/factory.js';
import { buildKey } from '../../../src/identify.js';
import { fromIoredis, type RedisScriptClient } from '../../../src/redis/client.js';
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
