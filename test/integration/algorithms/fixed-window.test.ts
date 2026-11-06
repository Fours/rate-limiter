import { describe, expect, it } from 'vitest';
import {
  createRedisFixedWindow,
  createRedisFixedWindowForTest,
} from '../../../src/algorithms/redis/fixed-window.js';
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
const redisWindow = withFakeClock(r, createRedisFixedWindowForTest);

describeAlgorithm('Redis fixed window', redisWindow, {
  burst: (rule) => rule.limit,
  // A full window's worth at the end of one window, and again at the start of the next.
  maxPerWindow: (rule) => 2 * rule.limit,
});

/**
 * The same rules as fixed-window.lua, written again in TypeScript, so the script is checked
 * against an independent version step for step. FakeClock's default start is a whole minute and
 * a whole day, which keeps the expected values in the tests below easy to read.
 */
function referenceModel(clock: FakeClock): Algorithm {
  const state = new Map<string, { end: number; count: number; last: number }>();
  return {
    check(key: string, rule: Rule): Promise<Decision> {
      const stored = state.get(key);
      const now = Math.max(clock.now(), stored?.last ?? Number.NEGATIVE_INFINITY);
      let end: number;
      let count: number;
      if (stored === undefined || now >= stored.end) {
        end = Math.floor(now / rule.windowMs) * rule.windowMs + rule.windowMs;
        count = 0;
      } else {
        ({ end, count } = stored);
      }
      const allowed = count < rule.limit;
      if (allowed) count++;
      state.set(key, { end, count, last: now });
      return Promise.resolve({
        allowed,
        remaining: Math.max(0, rule.limit - count),
        resetMs: end - now,
      });
    },
  };
}

function freshRule(overrides: Partial<Omit<Rule, 'id'>> = {}): Rule {
  return { id: uniqueRuleId('fixed'), limit: 3, windowMs: 60_000, ...overrides };
}

describe('Redis fixed window', () => {
  it('returns exactly the same decisions as the reference model, step for step', async () => {
    const steps = comparisonSteps();
    const modelClock = new FakeClock();
    const expected = await runSteps(referenceModel(modelClock), modelClock, steps);
    const { algorithm, clock } = redisWindow();
    expect(await runSteps(algorithm, clock, steps)).toStrictEqual(expected);
    expect(expected.some((d) => !d.allowed)).toBe(true);
  });

  it('resets exactly at the window boundary', async () => {
    const { algorithm, clock } = redisWindow();
    const rule = freshRule();
    const key = buildKey(rule, 'c');
    for (let i = 0; i < 3; i++) await algorithm.check(key, rule);
    expect(await algorithm.check(key, rule)).toStrictEqual({
      allowed: false,
      remaining: 0,
      resetMs: 60_000,
    });

    clock.advance(59_999);
    expect(await algorithm.check(key, rule)).toStrictEqual({
      allowed: false,
      remaining: 0,
      resetMs: 1,
    });
    clock.advance(1);
    expect(await algorithm.check(key, rule)).toStrictEqual({
      allowed: true,
      remaining: 2,
      resetMs: 60_000,
    });
  });

  it('allows 2x the limit across a boundary: its documented weakness', async () => {
    const { algorithm, clock } = redisWindow();
    const rule = freshRule();
    const key = buildKey(rule, 'c');
    clock.advance(59_999); // the last millisecond of a window

    const allowed: boolean[] = [];
    for (let i = 0; i < 3; i++) allowed.push((await algorithm.check(key, rule)).allowed);
    clock.advance(1); // the first millisecond of the next
    for (let i = 0; i < 4; i++) allowed.push((await algorithm.check(key, rule)).allowed);

    // Six requests within 2 ms against a limit of 3 per minute, then a denial.
    expect(allowed).toStrictEqual([true, true, true, true, true, true, false]);
  });

  it('aligns windows to the epoch, not to the first request', async () => {
    const { algorithm, clock } = redisWindow();
    const rule = freshRule();
    clock.advance(30_000);
    expect(await algorithm.check(buildKey(rule, 'c'), rule)).toMatchObject({ resetMs: 30_000 });
  });

  describe('expiry', () => {
    it('sets the TTL to the end of the window', async () => {
      const { algorithm, clock } = redisWindow();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      clock.advance(12_345);
      await algorithm.check(key, rule);
      await expectTtlNear(r.redis, key, 60_000 - 12_345);
    });

    it('loses nothing when the key expires: a deleted key gives the same answer as a kept one', async () => {
      const { algorithm, clock } = redisWindow();
      const rule = freshRule();
      const kept = buildKey(rule, 'kept');
      const expired = buildKey(rule, 'expired');
      for (let i = 0; i < 3; i++) {
        await algorithm.check(kept, rule);
        await algorithm.check(expired, rule);
      }
      const last = await algorithm.check(expired, rule);

      clock.advance(last.resetMs);
      await r.redis.del(expired); // what Redis does when the TTL runs out
      expect(await algorithm.check(expired, rule)).toStrictEqual(await algorithm.check(kept, rule));
    });
  });

  describe('a rule change mid-window', () => {
    it('counts what was already used against a smaller limit', async () => {
      const { algorithm } = redisWindow();
      const rule = freshRule({ limit: 5 });
      const key = buildKey(rule, 'c');
      await algorithm.check(key, rule);
      await algorithm.check(key, rule);

      const smaller = { ...rule, limit: 3 };
      expect(await algorithm.check(key, smaller)).toMatchObject({ allowed: true, remaining: 0 });
      expect(await algorithm.check(key, smaller)).toMatchObject({ allowed: false, remaining: 0 });
    });

    it('allows the difference when the limit grows, because denied requests never counted', async () => {
      const { algorithm } = redisWindow();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      for (let i = 0; i < 6; i++) await algorithm.check(key, rule); // 3 allowed, 3 denied

      const bigger = { ...rule, limit: 5 };
      expect(await algorithm.check(key, bigger)).toMatchObject({ allowed: true, remaining: 1 });
      expect(await algorithm.check(key, bigger)).toMatchObject({ allowed: true, remaining: 0 });
      expect(await algorithm.check(key, bigger)).toMatchObject({ allowed: false });
    });

    it('keeps the current window to its end when windowMs changes, then aligns to the new size', async () => {
      const { algorithm, clock } = redisWindow();
      const rule = freshRule({ limit: 5 });
      const key = buildKey(rule, 'c');
      clock.advance(10_000);
      await algorithm.check(key, rule);

      const shorter = { ...rule, windowMs: 30_000 };
      // Still the 60 s window that started at 0: its end, and its count.
      expect(await algorithm.check(key, shorter)).toStrictEqual({
        allowed: true,
        remaining: 3,
        resetMs: 50_000,
      });
      clock.advance(50_000);
      // Then 30 s windows, aligned to the epoch: 60 s is a 30 s boundary too.
      expect(await algorithm.check(key, shorter)).toStrictEqual({
        allowed: true,
        remaining: 4,
        resetMs: 30_000,
      });
    });
  });

  describe('switching algorithms (decision 0016)', () => {
    it('starts fresh over a hash from another algorithm, even when its field names overlap', async () => {
      const { algorithm, clock } = redisWindow();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      // Shaped like a used-up fixed window, but tagged as another algorithm's. Without the tag
      // check it would be read as this window's state and deny the request.
      const now = String(clock.now());
      await r.redis.hset(
        key,
        'alg',
        'sliding-window-counter',
        'start',
        now,
        'end',
        String(clock.now() + 60_000),
        'count',
        '3',
        'last',
        now,
      );
      expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 2 });
    });

    it.each([
      [
        'token bucket to fixed window',
        createRedisTokenBucketForTest,
        createRedisFixedWindowForTest,
      ],
      [
        'fixed window to token bucket',
        createRedisFixedWindowForTest,
        createRedisTokenBucketForTest,
      ],
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
  });

  it('uses Redis time when built through the public factory', async () => {
    const algorithm = createRedisFixedWindow({ client: r.client });
    // A window of 10^12 ms (about 32 years), so real time can't cross a boundary mid-test:
    // the boundaries are at 2001-09-09 and 2033-05-18.
    const rule = freshRule({ windowMs: 1_000_000_000_000 });
    const key = buildKey(rule, 'c');
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push((await algorithm.check(key, rule)).allowed);
    expect(results).toStrictEqual([true, true, true, false]);
  });
});
