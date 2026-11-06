import type { Redis } from 'ioredis';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenBucket } from '../../../src/algorithms/token-bucket.js';
import {
  createRedisTokenBucket,
  createRedisTokenBucketForTest,
} from '../../../src/algorithms/redis/token-bucket.js';
import { buildKey } from '../../../src/identify.js';
import { fromIoredis, type RedisScriptClient } from '../../../src/redis/client.js';
import type { Algorithm, Decision, Rule } from '../../../src/types.js';
import { describeAlgorithm } from '../../contract/algorithm-contract.js';
import { FakeClock } from '../../helpers/fake-clock.js';
import { connectIoredis, uniqueRuleId } from '../helpers/redis.js';

let redis: Redis;
let client: RedisScriptClient;

beforeAll(async () => {
  redis = await connectIoredis();
  client = fromIoredis(redis);
});

afterAll(async () => {
  await redis.quit();
});

function redisBucket(): { algorithm: Algorithm; clock: FakeClock } {
  const clock = new FakeClock();
  return { algorithm: createRedisTokenBucketForTest({ client, clock }), clock };
}

describeAlgorithm('Redis token bucket', redisBucket, {
  burst: (rule) => rule.limit,
  maxPerWindow: (rule) => 2 * rule.limit - 1,
});

describe('Redis token bucket', () => {
  it('returns exactly the same decisions as the in-memory bucket, step for step', async () => {
    const id = uniqueRuleId('parity');
    const base: Rule = { id, limit: 5, windowMs: 60_000 };
    const daily: Rule = { id: `${id}:daily`, limit: 48, windowMs: 86_400_000 };
    // [ms to advance (negative: clock steps back), rule, client]
    const steps: [number, Rule, string][] = [];
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

    const run = async (algorithm: Algorithm, clock: FakeClock): Promise<Decision[]> => {
      const out: Decision[] = [];
      for (const [gap, rule, who] of steps) {
        clock.set(clock.now() + gap);
        out.push(await algorithm.check(buildKey(rule, who), rule));
      }
      return out;
    };

    const memoryClock = new FakeClock();
    const memory = createTokenBucket({ clock: memoryClock });
    const expected = await run(memory, memoryClock);
    memory.close();
    const { algorithm, clock } = redisBucket();
    expect(await run(algorithm, clock)).toStrictEqual(expected);
    expect(expected.some((d) => !d.allowed)).toBe(true);
  });

  describe('expiry', () => {
    it('sets the TTL to the time until the bucket is full, after allowed and denied checks', async () => {
      const { algorithm } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('ttl'), limit: 10, windowMs: 60_000 };
      const key = buildKey(rule, 'c');

      const allowed = await algorithm.check(key, rule);
      // Allowed resetMs is "until full", which is exactly what the TTL should be.
      await expectTtlNear(key, allowed.resetMs);

      for (let i = 0; i < 10; i++) await algorithm.check(key, rule);
      await expectTtlNear(key, rule.windowMs);
    });

    it('loses nothing when the key expires: a deleted key gives the same answer as a kept one', async () => {
      const rule: Rule = { id: uniqueRuleId('expire'), limit: 3, windowMs: 60_000 };
      const { algorithm, clock } = redisBucket();
      const kept = buildKey(rule, 'kept');
      const expired = buildKey(rule, 'expired');
      await algorithm.check(kept, rule);
      const last = await algorithm.check(expired, rule);

      clock.advance(last.resetMs);
      await redis.del(expired); // what Redis does when the TTL runs out
      expect(await algorithm.check(expired, rule)).toStrictEqual(await algorithm.check(kept, rule));
    });
  });

  describe('a limit change on the same key', () => {
    it('carries over whole tokens only, never more than the new limit', async () => {
      const { algorithm, clock } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('change'), limit: 10, windowMs: 60_000 };
      const key = buildKey(rule, 'c');
      const capped = buildKey(rule, 'capped');
      for (let i = 0; i < 3; i++) {
        await algorithm.check(key, rule);
        await algorithm.check(capped, rule);
      }
      // Half a token's worth of time: 7.5 tokens each.
      clock.advance(3_000);

      // 7 whole tokens carried, not 7.5. One taken leaves 6 of 9; the 3 missing refill at
      // 9 per minute, so 20 s. Carrying 7.5 would say 16 667 ms.
      const shrunk = await algorithm.check(key, { ...rule, limit: 9 });
      expect(shrunk).toStrictEqual({ allowed: true, remaining: 6, resetMs: 20_000 });
      // Never more than the new limit: 7 tokens become 4, one taken.
      const tiny = await algorithm.check(capped, { ...rule, limit: 4 });
      expect(tiny).toMatchObject({ allowed: true, remaining: 3 });
    });

    it('carries the whole tokens into a bigger limit, then refills at the new rate', async () => {
      const { algorithm } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('grow'), limit: 10, windowMs: 60_000 };
      const key = buildKey(rule, 'c');
      for (let i = 0; i < 3; i++) await algorithm.check(key, rule);

      const grown = await algorithm.check(key, { ...rule, limit: 20 });
      // 7 tokens carried over and 1 taken leaves 6 of 20. The 14 missing tokens refill at the
      // new rate of 20 per minute (3 s each): full again in 42 s.
      expect(grown).toStrictEqual({ allowed: true, remaining: 6, resetMs: 42_000 });
    });
  });

  it('uses Redis time when built through the public factory', async () => {
    const algorithm = createRedisTokenBucket({ client });
    const rule: Rule = { id: uniqueRuleId('time'), limit: 3, windowMs: 60_000 };
    const key = buildKey(rule, 'c');
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await algorithm.check(key, rule)).allowed);
    expect(results).toStrictEqual([true, true, true, false]);
  });

  describe('state left by another algorithm', () => {
    it.each([
      ['a sorted set', (key: string) => redis.zadd(key, 1, 'x')],
      ['a string', (key: string) => redis.set(key, '42')],
      [
        'a hash tagged with another algorithm',
        (key: string) => redis.hset(key, 'alg', 'fixed-window', 'units', '0'),
      ],
      ['an untagged hash', (key: string) => redis.hset(key, 'units', '0', 'last', '0')],
    ])('starts fresh over %s, without a WRONGTYPE error', async (_label, plant) => {
      const { algorithm } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('switch'), limit: 4, windowMs: 60_000 };
      const key = buildKey(rule, 'c');
      await plant(key);
      expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 3 });
      expect(await redis.type(key)).toBe('hash');
    });
  });

  describe('startup checks', () => {
    it.each([
      ['a raw ioredis client', () => redis, /fromIoredis/],
      ['a raw node-redis client', () => createClient(), /fromNodeRedis/],
      ['null', () => null, /RedisScriptClient/],
    ])('rejects %s', (_label, value, message) => {
      expect(() =>
        createRedisTokenBucket({ client: value() as unknown as RedisScriptClient }),
      ).toThrow(message);
    });
  });
});

async function expectTtlNear(key: string, ms: number): Promise<void> {
  const ttl = await redis.pttl(key);
  // Real time passes between the check and PTTL; allow for a slow CI machine.
  expect(ttl).toBeLessThanOrEqual(ms);
  expect(ttl).toBeGreaterThan(ms - 1_000);
}
