import { describe, expect, it } from 'vitest';
import { createRedisFixedWindowForTest } from '../../../src/algorithms/redis/fixed-window.js';
import {
  createRedisSlidingWindowCounter,
  createRedisSlidingWindowCounterForTest,
} from '../../../src/algorithms/redis/sliding-window-counter.js';
import { createRedisSlidingWindowLogForTest } from '../../../src/algorithms/redis/sliding-window-log.js';
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
const redisCounter = withFakeClock(r, createRedisSlidingWindowCounterForTest);
const W = 60_000;

describeAlgorithm('Redis sliding window counter', redisCounter, {
  burst: (rule) => rule.limit,
  // An estimate: a full previous window that all arrived at its very end still counts as spread
  // evenly, so a sliding windowMs span can see up to nearly twice the limit.
  maxPerWindow: (rule) => 2 * rule.limit,
});

/**
 * The same rules as sliding-window-counter.lua, written again in TypeScript. The denied wait is
 * found by stepping forward a millisecond at a time instead of by the script's formula, so the
 * formula is checked against a brute-force answer.
 */
function referenceModel(clock: FakeClock): Algorithm {
  type State = { start: number; window: number; curr: number; prev: number; last: number };
  const state = new Map<string, State>();
  return {
    check(key: string, rule: Rule): Promise<Decision> {
      const w = rule.windowMs;
      const stored = state.get(key);
      const now = Math.max(clock.now(), stored?.last ?? Number.NEGATIVE_INFINITY);
      const start = Math.floor(now / w) * w;
      let curr = 0;
      let prev = 0;
      if (stored !== undefined) {
        if (stored.window !== w) {
          if (now < stored.start + 2 * stored.window) curr = stored.curr + stored.prev;
        } else if (stored.start === start) {
          ({ curr, prev } = stored);
        } else if (stored.start === start - w) {
          prev = stored.curr;
        }
      }
      const fits = (p: number, c: number, e: number) => p * (w - e) + (c + 1) * w <= rule.limit * w;
      const e = now - start;
      const allowed = fits(prev, curr, e);
      if (allowed) curr++;
      state.set(key, { start, window: w, curr, prev, last: now });

      let resetMs = 2 * w - e;
      if (!allowed) {
        resetMs = 1;
        for (;;) {
          const at = e + resetMs;
          const ok = at < w ? fits(prev, curr, at) : at < 2 * w ? fits(curr, 0, at - w) : true;
          if (ok) break;
          resetMs++;
        }
      }
      const estimate = prev * (w - e) + curr * w;
      const remaining = Math.max(0, Math.floor((rule.limit * w - estimate) / w));
      return Promise.resolve({ allowed, remaining, resetMs });
    },
  };
}

function freshRule(overrides: Partial<Omit<Rule, 'id'>> = {}): Rule {
  return { id: uniqueRuleId('counter'), limit: 4, windowMs: W, ...overrides };
}

/**
 * Makes `count` requests at the start of the current window, then moves into the next one, so
 * they become the previous window's. (Never step the clock back: the scripts treat that as
 * standing still.)
 */
async function fillPreviousWindow(
  algorithm: Algorithm,
  clock: FakeClock,
  key: string,
  rule: Rule,
  count: number,
) {
  for (let i = 0; i < count; i++) await algorithm.check(key, rule);
  clock.advance(W);
}

async function allowedNow(algorithm: Algorithm, key: string, rule: Rule): Promise<number> {
  let allowed = 0;
  while ((await algorithm.check(key, rule)).allowed) allowed++;
  return allowed;
}

describe('Redis sliding window counter', () => {
  it('returns exactly the same decisions as the reference model, step for step', async () => {
    const steps = comparisonSteps();
    const modelClock = new FakeClock();
    const expected = await runSteps(referenceModel(modelClock), modelClock, steps);
    const { algorithm, clock } = redisCounter();
    expect(await runSteps(algorithm, clock, steps)).toStrictEqual(expected);
    expect(expected.some((d) => !d.allowed)).toBe(true);
  });

  describe('the weighted estimate, after a previous window that used the whole limit of 4', () => {
    it.each([
      ['at 0% of the window: the previous window counts in full', 0, 0],
      ['at 50%: half of it counts, so 2 fit', W / 2, 2],
      ['in the last millisecond: a sliver still counts, so 3 fit, not 4', W - 1, 3],
    ])('%s', async (_label, into, expected) => {
      // FakeClock's default start is a whole minute: a window boundary.
      const { algorithm, clock } = redisCounter();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      await fillPreviousWindow(algorithm, clock, key, rule, 4);
      clock.advance(into);
      expect(await allowedNow(algorithm, key, rule)).toBe(expected);
    });
  });

  describe('the exact denied resetMs', () => {
    it('later in this window, as the previous share shrinks', async () => {
      const { algorithm, clock } = redisCounter();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      await fillPreviousWindow(algorithm, clock, key, rule, 4);
      // At 0%: prev 4 counts in full. One more fits once 4 * (W - e) <= 3 * W: at e = 15 s.
      expect(await algorithm.check(key, rule)).toStrictEqual({
        allowed: false,
        remaining: 0,
        resetMs: 15_000,
      });
    });

    it('in the next window, as this window becomes the previous one', async () => {
      const { algorithm, clock } = redisCounter();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      clock.advance(40_000);
      for (let i = 0; i < 4; i++) await algorithm.check(key, rule);
      // 20 s left in this window; then curr 4 becomes prev and fits once 4 * (W - e') <= 3 * W,
      // at e' = 15 s. 20 + 15 = 35 s.
      expect(await algorithm.check(key, rule)).toStrictEqual({
        allowed: false,
        remaining: 0,
        resetMs: 35_000,
      });
    });

    it('not before the window after next, with a limit of 1', async () => {
      const { algorithm, clock } = redisCounter();
      const rule = freshRule({ limit: 1 });
      const key = buildKey(rule, 'c');
      clock.advance(10_000);
      await algorithm.check(key, rule);
      // The one request counts in full until the end of the next window: 50 + 60 = 110 s.
      expect(await algorithm.check(key, rule)).toStrictEqual({
        allowed: false,
        remaining: 0,
        resetMs: 110_000,
      });
    });

    it('after the limit shrinks below the current count', async () => {
      const { algorithm, clock } = redisCounter();
      const rule = freshRule({ limit: 6 });
      const key = buildKey(rule, 'c');
      clock.advance(30_000);
      for (let i = 0; i < 6; i++) await algorithm.check(key, rule);
      // With a limit of 2, curr 6 must shrink in the next window until 6 * (W - e') <= W,
      // at e' = 50 s. 30 + 50 = 80 s.
      expect(await algorithm.check(key, { ...rule, limit: 2 })).toStrictEqual({
        allowed: false,
        remaining: 0,
        resetMs: 80_000,
      });
    });

    it('is tight across 40 seeded random histories: denied 1 ms before, allowed at it', async () => {
      const random = mulberry32(20261106);
      const pick = (n: number) => Math.floor(random() * n);
      for (let run = 0; run < 40; run++) {
        const { algorithm, clock } = redisCounter();
        const rule = freshRule({ limit: 1 + pick(6) });
        const key = buildKey(rule, 'c');
        clock.advance(pick(W));
        let denied: Decision | undefined;
        while (denied === undefined) {
          clock.advance(pick(25_000));
          const decision = await algorithm.check(key, rule);
          if (!decision.allowed) denied = decision;
        }
        clock.advance(denied.resetMs - 1);
        expect(await algorithm.check(key, rule), `run ${String(run)}, 1 ms early`).toMatchObject({
          allowed: false,
          resetMs: 1,
        });
        clock.advance(1);
        expect((await algorithm.check(key, rule)).allowed, `run ${String(run)}, on time`).toBe(
          true,
        );
      }
    });
  });

  describe('expiry', () => {
    it('sets the TTL to the end of the next window', async () => {
      const { algorithm, clock } = redisCounter();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      clock.advance(12_345);
      await algorithm.check(key, rule);
      await expectTtlNear(r.redis, key, 2 * W - 12_345);
    });

    it('loses nothing when the key expires: a deleted key gives the same answer as a kept one', async () => {
      const { algorithm, clock } = redisCounter();
      const rule = freshRule();
      const kept = buildKey(rule, 'kept');
      const expired = buildKey(rule, 'expired');
      clock.advance(20_000);
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

  it('counts both windows in the current one when windowMs changes, so nothing is gained', async () => {
    const { algorithm, clock } = redisCounter();
    const rule = freshRule({ limit: 5 });
    const key = buildKey(rule, 'c');
    await fillPreviousWindow(algorithm, clock, key, rule, 2);
    clock.advance(30_000);
    await algorithm.check(key, rule); // prev 2, curr 1: estimate 2 * 0.5 + 1 = 2

    // In 2-minute windows, all 3 count in the current window, so 2 more fit.
    expect(await allowedNow(algorithm, key, { ...rule, windowMs: 120_000 })).toBe(2);
  });

  describe('switching algorithms (decision 0016)', () => {
    const others = [
      ['token bucket', createRedisTokenBucketForTest],
      ['fixed window', createRedisFixedWindowForTest],
      ['sliding window log', createRedisSlidingWindowLogForTest],
    ] as const;
    it.each(
      others.flatMap(([name, other]) => [
        [`${name} to counter`, other, createRedisSlidingWindowCounterForTest],
        [`counter to ${name}`, createRedisSlidingWindowCounterForTest, other],
      ]),
    )('%s starts the client fresh, with no WRONGTYPE error', async (_label, before, after) => {
      const clock = new FakeClock();
      const old = before({ client: r.client, clock });
      const next = after({ client: r.client, clock });
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      for (let i = 0; i < 4; i++) await old.check(key, rule);
      expect((await old.check(key, rule)).allowed).toBe(false);

      expect(await next.check(key, rule)).toMatchObject({ allowed: true, remaining: 3 });
    });

    it('starts fresh over a token-bucket hash, which shares the window field name', async () => {
      const { algorithm, clock } = redisCounter();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      const start = String(clock.now());
      // Shaped like a used-up counter window, but tagged as the token bucket's.
      await r.redis.hset(
        key,
        'alg',
        'token-bucket',
        'start',
        start,
        'window',
        String(W),
        'curr',
        '4',
        'prev',
        '0',
        'last',
        start,
      );
      expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 3 });
    });
  });

  it('uses Redis time when built through the public factory', async () => {
    const algorithm = createRedisSlidingWindowCounter({ client: r.client });
    const rule = freshRule({ limit: 3, windowMs: 1_000_000_000_000 });
    const key = buildKey(rule, 'c');
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push((await algorithm.check(key, rule)).allowed);
    expect(results).toStrictEqual([true, true, true, false]);
  });
});

/** A small seeded PRNG, so the random histories are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
