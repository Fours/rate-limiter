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
  burstSteps,
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

  describe('burst', () => {
    it('returns exactly the same decisions as the in-memory bucket, with bursts', async () => {
      const steps = burstSteps();
      const memoryClock = new FakeClock();
      const memory = createTokenBucket({ clock: memoryClock });
      const expected = await runSteps(memory, memoryClock, steps);
      memory.close();

      const { algorithm, clock } = redisBucket();
      expect(await runSteps(algorithm, clock, steps)).toStrictEqual(expected);
      expect(expected.some((d) => !d.allowed)).toBe(true);
      expect(expected.some((d) => d.remaining > 5)).toBe(true); // a burst above the limit
    });

    it('says it takes a burst', () => {
      expect(createRedisTokenBucket({ client: r.client }).supportsBurst).toBe(true);
    });

    it('allows burst at once, then limit per windowMs', async () => {
      const { algorithm, clock } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('burst'), limit: 60, windowMs: 60_000, burst: 10 };
      const key = buildKey(rule, 'c');
      let allowed = 0;
      while ((await algorithm.check(key, rule)).allowed) allowed++;
      expect(allowed).toBe(10);
      clock.advance(1_000);
      expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 0 });
    });

    it('reads state written before bursts existed, with no burst field', async () => {
      const { algorithm, clock } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('old'), limit: 10, windowMs: 1_000 };
      const key = buildKey(rule, 'c');
      // What the script stored before this change: 3 tokens left, at the clock's current time.
      await r.redis.hset(key, {
        alg: 'token-bucket',
        units: 3 * 1_000,
        last: clock.now(),
        limit: 10,
        window: 1_000,
      });
      expect(await algorithm.check(key, rule)).toStrictEqual({
        allowed: true,
        remaining: 2,
        resetMs: 800,
      });
      // The capacity was the limit: 10 tokens after a long wait, not more.
      clock.advance(60_000);
      expect(await algorithm.check(key, rule)).toMatchObject({ remaining: 9 });
      expect(await r.redis.hexists(key, 'burst')).toBe(0);
    });

    it('stores a burst only when it differs from the limit, and removes it when it goes', async () => {
      const { algorithm } = redisBucket();
      const rule: Rule = { id: uniqueRuleId('field'), limit: 10, windowMs: 1_000 };
      const key = buildKey(rule, 'c');
      await algorithm.check(key, { ...rule, burst: 10 });
      expect(await r.redis.hexists(key, 'burst')).toBe(0);
      await algorithm.check(key, { ...rule, burst: 4 });
      expect(await r.redis.hget(key, 'burst')).toBe('4');
      await algorithm.check(key, rule);
      expect(await r.redis.hexists(key, 'burst')).toBe(0);
    });
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
    it('carries over the tokens and the fraction of the next, never more than the new limit', async () => {
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

      // 7.5 tokens carried (0031). One taken leaves 6.5 of 9; the 2.5 missing refill at 9 per
      // minute, so 16 667 ms. Whole tokens only, as before 0031, would say 20 s.
      const shrunk = await algorithm.check(key, { ...rule, limit: 9 });
      expect(shrunk).toStrictEqual({ allowed: true, remaining: 6, resetMs: 16_667 });
      // Never more than the new limit: 7.5 tokens become 4, one taken.
      const tiny = await algorithm.check(capped, { ...rule, limit: 4 });
      expect(tiny).toMatchObject({ allowed: true, remaining: 3 });
    });

    it('keeps refilling a client whose checks alternate between two rules (0031)', async () => {
      const { algorithm, clock } = redisBucket();
      const oldRule: Rule = { id: uniqueRuleId('mixed'), limit: 2, windowMs: 60_000 };
      const newRule: Rule = { ...oldRule, limit: 3 };
      const key = buildKey(oldRule, 'c');
      await algorithm.check(key, oldRule);
      await algorithm.check(key, oldRule);
      let allowed = 0;
      for (let i = 0; i < 60; i++) {
        clock.advance(10_000);
        if ((await algorithm.check(key, i % 2 === 0 ? newRule : oldRule)).allowed) allowed++;
      }
      // Both refill at least 2 a minute: 20 in 10 minutes, and at most 30. Whole tokens gave 0.
      expect(allowed).toBeGreaterThanOrEqual(20);
      expect(allowed).toBeLessThanOrEqual(30);
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
