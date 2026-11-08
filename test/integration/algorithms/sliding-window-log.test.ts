import { describe, expect, it } from 'vitest';
import { createRedisFixedWindowForTest } from '../../../src/algorithms/redis/fixed-window.js';
import {
  createRedisSlidingWindowLog,
  createRedisSlidingWindowLogForTest,
} from '../../../src/algorithms/redis/sliding-window-log.js';
import { createRedisTokenBucketForTest } from '../../../src/algorithms/redis/token-bucket.js';
import { buildKey } from '../../../src/identify.js';
import type { Algorithm, Decision, Rule } from '../../../src/types.js';
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
const redisLog = withFakeClock(r, createRedisSlidingWindowLogForTest);
const TAG = 'alg:sliding-window-log';

describeAlgorithm('Redis sliding window log', redisLog, {
  burst: (rule) => rule.limit,
  // Exact: never more than the limit in any window.
  maxPerWindow: (rule) => rule.limit,
});

/** The same rules as sliding-window-log.lua, written again in TypeScript as a list of times. */
function referenceModel(clock: FakeClock): Algorithm {
  const state = new Map<string, { times: number[]; last: number }>();
  return {
    check(key: string, rule: Rule): Promise<Decision> {
      const stored = state.get(key) ?? { times: [], last: Number.NEGATIVE_INFINITY };
      const now = Math.max(clock.now(), stored.last);
      const times = stored.times.filter((t) => t > now - rule.windowMs);
      const allowed = times.length < rule.limit;
      if (allowed) times.push(now);
      state.set(key, { times, last: now });
      const oldestToFree = times[times.length - rule.limit] ?? 0;
      return Promise.resolve({
        allowed,
        remaining: Math.max(0, rule.limit - times.length),
        resetMs: allowed ? rule.windowMs : oldestToFree + rule.windowMs - now,
      });
    },
  };
}

function freshRule(overrides: Partial<Omit<Rule, 'id'>> = {}): Rule {
  return { id: uniqueRuleId('log'), limit: 3, windowMs: 60_000, ...overrides };
}

describe('Redis sliding window log', () => {
  it('returns exactly the same decisions as the reference model, step for step', async () => {
    const steps = comparisonSteps();
    const modelClock = new FakeClock();
    const expected = await runSteps(referenceModel(modelClock), modelClock, steps);
    const { algorithm, clock } = redisLog();
    expect(await runSteps(algorithm, clock, steps)).toStrictEqual(expected);
    expect(expected.some((d) => !d.allowed)).toBe(true);
  });

  describe('being exact across a boundary', () => {
    it('frees a slot exactly when the oldest request ages out, then waits for the next', async () => {
      const { algorithm, clock } = redisLog();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      for (const at of [0, 10_000, 20_000]) {
        clock.set(new FakeClock().now() + at);
        await algorithm.check(key, rule);
      }
      clock.set(new FakeClock().now() + 59_999);
      expect(await algorithm.check(key, rule)).toStrictEqual({
        allowed: false,
        remaining: 0,
        resetMs: 1,
      });
      clock.advance(1);
      expect(await algorithm.check(key, rule)).toStrictEqual({
        allowed: true,
        remaining: 0,
        resetMs: 60_000,
      });
      expect(await algorithm.check(key, rule)).toStrictEqual({
        allowed: false,
        remaining: 0,
        resetMs: 10_000,
      });
    });

    it('allows only the limit across a minute boundary, where a fixed window allows twice that', async () => {
      const burst = async (algorithm: Algorithm, clock: FakeClock): Promise<number> => {
        const rule = freshRule();
        const key = buildKey(rule, 'c');
        let allowed = 0;
        clock.advance(59_999); // the last millisecond of a minute
        for (let i = 0; i < 3; i++) if ((await algorithm.check(key, rule)).allowed) allowed++;
        clock.advance(1); // the first of the next
        for (let i = 0; i < 3; i++) if ((await algorithm.check(key, rule)).allowed) allowed++;
        return allowed;
      };
      const log = redisLog();
      const fixedClock = new FakeClock();
      const fixed = createRedisFixedWindowForTest({ client: r.client, clock: fixedClock });
      expect(await burst(log.algorithm, log.clock)).toBe(3);
      expect(await burst(fixed, fixedClock)).toBe(6);
    });
  });

  it('counts every request in the same millisecond', async () => {
    const { algorithm } = redisLog();
    const rule = freshRule({ limit: 5 });
    const key = buildKey(rule, 'c');
    const remaining: number[] = [];
    for (let i = 0; i < 3; i++) remaining.push((await algorithm.check(key, rule)).remaining);
    expect(remaining).toStrictEqual([4, 3, 2]);
    // Three entries plus the tag member.
    expect(await r.redis.zcard(key)).toBe(4);
  });

  it('records every allowed request when windowMs shrinks within one millisecond', async () => {
    // Found by the 1.0 correctness review: named by the live count, the entry for the first
    // request under the shorter window reused the name of one already there, so ZADD
    // overwrote it and every request in that millisecond was allowed.
    const { algorithm, clock } = redisLog();
    const long = freshRule({ limit: 5, windowMs: 60_000 });
    const short: Rule = { ...long, windowMs: 10_000 };
    const key = buildKey(long, 'c');
    const t0 = clock.now();
    clock.set(t0 - 30_000);
    await algorithm.check(key, long);
    await algorithm.check(key, long);
    clock.set(t0);
    await algorithm.check(key, long);
    let allowed = 0;
    for (let i = 0; i < 20; i++) if ((await algorithm.check(key, short)).allowed) allowed++;
    expect(allowed).toBe(4);
    expect(await r.redis.zcount(key, '(0', '+inf')).toBe(5);
  });

  it('after the limit shrinks, waits for the entry that brings the count below the new limit', async () => {
    const { algorithm, clock } = redisLog();
    const rule = freshRule({ limit: 5 });
    const key = buildKey(rule, 'c');
    for (let i = 0; i < 5; i++) {
      await algorithm.check(key, rule); // entries at 0, 1, 2, 3 and 4 s
      clock.advance(1_000);
    }
    // At 5 s, 5 entries are live against a limit of 3. Three must age out to free one slot,
    // so the wait is for the entry at 2 s: 2 + 60 - 5 = 57 s. The oldest would say 55 s.
    expect(await algorithm.check(key, { ...rule, limit: 3 })).toStrictEqual({
      allowed: false,
      remaining: 0,
      resetMs: 57_000,
    });
  });

  it('never stores more than limit entries, however many requests are denied', async () => {
    const { algorithm } = redisLog();
    const rule = freshRule();
    const key = buildKey(rule, 'c');
    for (let i = 0; i < 103; i++) await algorithm.check(key, rule);
    expect(await r.redis.zcard(key)).toBe(rule.limit + 1);
  });

  describe('expiry', () => {
    it('sets the TTL to when the newest entry ages out', async () => {
      const { algorithm, clock } = redisLog();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      await algorithm.check(key, rule);
      clock.advance(20_000);
      await algorithm.check(key, rule);
      clock.advance(5_000);
      await algorithm.check(key, rule);
      await algorithm.check(key, rule); // denied: the newest is still the one from just now
      await expectTtlNear(r.redis, key, 60_000);

      // At 60 s the entry from 0 s ages out, which frees a slot; the new request is the newest.
      clock.advance(35_000);
      expect((await algorithm.check(key, rule)).allowed).toBe(true);
      await expectTtlNear(r.redis, key, 60_000);
    });

    it('loses nothing when the key expires: a deleted key gives the same answer as a kept one', async () => {
      const { algorithm, clock } = redisLog();
      const rule = freshRule();
      const kept = buildKey(rule, 'kept');
      const expired = buildKey(rule, 'expired');
      for (let i = 0; i < 3; i++) {
        await algorithm.check(kept, rule);
        await algorithm.check(expired, rule);
        clock.advance(7_000);
      }
      clock.advance(60_000); // past the newest entry's age-out
      await r.redis.del(expired); // what Redis does when the TTL runs out
      expect(await algorithm.check(expired, rule)).toStrictEqual(await algorithm.check(kept, rule));
    });
  });

  describe('switching algorithms (decision 0016)', () => {
    it.each([
      ['token bucket to log', createRedisTokenBucketForTest, createRedisSlidingWindowLogForTest],
      ['log to token bucket', createRedisSlidingWindowLogForTest, createRedisTokenBucketForTest],
      ['fixed window to log', createRedisFixedWindowForTest, createRedisSlidingWindowLogForTest],
      ['log to fixed window', createRedisSlidingWindowLogForTest, createRedisFixedWindowForTest],
    ])('%s starts the client fresh, with no WRONGTYPE error', async (_label, before, after) => {
      const clock = new FakeClock();
      const old = before({ client: r.client, clock });
      const next = after({ client: r.client, clock });
      const rule = freshRule({ limit: 4 });
      const key = buildKey(rule, 'c');
      for (let i = 0; i < 4; i++) await old.check(key, rule);
      expect((await old.check(key, rule)).allowed).toBe(false);

      expect(await next.check(key, rule)).toMatchObject({ allowed: true, remaining: 3 });
    });

    it('starts fresh over a sorted set without its tag member', async () => {
      const { algorithm, clock } = redisLog();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      const now = clock.now();
      // Three live-looking entries that aren't this algorithm's: without the tag check, a denial.
      await r.redis.zadd(key, now, 'x', now, 'y', now, 'z');
      expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 2 });
      expect(await r.redis.zscore(key, TAG)).not.toBeNull();
    });
  });

  it('uses Redis time when built through the public factory', async () => {
    const algorithm = createRedisSlidingWindowLog({ client: r.client });
    const rule = freshRule({ windowMs: 1_000_000_000_000 });
    const key = buildKey(rule, 'c');
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push((await algorithm.check(key, rule)).allowed);
    expect(results).toStrictEqual([true, true, true, false]);
  });
});
