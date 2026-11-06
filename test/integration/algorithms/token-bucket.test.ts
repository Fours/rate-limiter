import { createClient } from 'redis';
import { describe, expect, it } from 'vitest';
import { createTokenBucket } from '../../../src/algorithms/token-bucket.js';
import {
  createRedisTokenBucket,
  createRedisTokenBucketForTest,
} from '../../../src/algorithms/redis/token-bucket.js';
import { buildKey } from '../../../src/identify.js';
import type { RedisScriptClient } from '../../../src/redis/client.js';
import type { Rule } from '../../../src/types.js';
import { describeAlgorithm } from '../../contract/algorithm-contract.js';
import { FakeClock } from '../../helpers/fake-clock.js';
import {
  comparisonSteps,
  expectTtlNear,
  runSteps,
  useRedis,
  withFakeClock,
} from '../helpers/algorithms.js';
import { uniqueRuleId } from '../helpers/redis.js';

const r = useRedis();
const redisBucket = withFakeClock(r, createRedisTokenBucketForTest);

describeAlgorithm('Redis token bucket', redisBucket, {
  burst: (rule) => rule.limit,
  maxPerWindow: (rule) => 2 * rule.limit - 1,
});

describe('Redis token bucket', () => {
  it('returns exactly the same decisions as the in-memory bucket, step for step', async () => {
    const steps = comparisonSteps();
    const memoryClock = new FakeClock();
    const memory = createTokenBucket({ clock: memoryClock });
    const expected = await runSteps(memory, memoryClock, steps);
    memory.close();

    const { algorithm, clock } = redisBucket();
    expect(await runSteps(algorithm, clock, steps)).toStrictEqual(expected);
    expect(expected.some((d) => !d.allowed)).toBe(true);
  });

  describe('expiry', () => {
    it('sets the TTL to the time until the bucket is full, after allowed and denied checks', async () => {
      const { algorithm } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('ttl'), limit: 10, windowMs: 60_000 };
      const key = buildKey(rule, 'c');

      const allowed = await algorithm.check(key, rule);
      // Allowed resetMs is "until full", which is exactly what the TTL should be.
      await expectTtlNear(r.redis, key, allowed.resetMs);

      for (let i = 0; i < 10; i++) await algorithm.check(key, rule);
      await expectTtlNear(r.redis, key, rule.windowMs);
    });

    it('loses nothing when the key expires: a deleted key gives the same answer as a kept one', async () => {
      const rule: Rule = { id: uniqueRuleId('expire'), limit: 3, windowMs: 60_000 };
      const { algorithm, clock } = redisBucket();
      const kept = buildKey(rule, 'kept');
      const expired = buildKey(rule, 'expired');
      await algorithm.check(kept, rule);
      const last = await algorithm.check(expired, rule);

      clock.advance(last.resetMs);
      await r.redis.del(expired); // what Redis does when the TTL runs out
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
    const algorithm = createRedisTokenBucket({ client: r.client });
    const rule: Rule = { id: uniqueRuleId('time'), limit: 3, windowMs: 60_000 };
    const key = buildKey(rule, 'c');
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await algorithm.check(key, rule)).allowed);
    expect(results).toStrictEqual([true, true, true, false]);
  });

  describe('state left by another algorithm', () => {
    it.each([
      ['a sorted set', (key: string) => r.redis.zadd(key, 1, 'x')],
      ['a string', (key: string) => r.redis.set(key, '42')],
      [
        'a hash tagged with another algorithm',
        (key: string) => r.redis.hset(key, 'alg', 'fixed-window', 'units', '0'),
      ],
      ['an untagged hash', (key: string) => r.redis.hset(key, 'units', '0', 'last', '0')],
    ])('starts fresh over %s, without a WRONGTYPE error', async (_label, plant) => {
      const { algorithm } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('switch'), limit: 4, windowMs: 60_000 };
      const key = buildKey(rule, 'c');
      await plant(key);
      expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 3 });
      expect(await r.redis.type(key)).toBe('hash');
    });
  });

  describe('startup checks', () => {
    it.each([
      ['a raw ioredis client', () => r.redis, /fromIoredis/],
      ['a raw node-redis client', () => createClient(), /fromNodeRedis/],
      ['null', () => null, /RedisScriptClient/],
    ])('rejects %s', (_label, value, message) => {
      expect(() =>
        createRedisTokenBucket({ client: value() as unknown as RedisScriptClient }),
      ).toThrow(message);
    });
  });
});
