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
import { slidingWindowCounterModel } from '../../helpers/models.js';
import {
  comparisonSteps,
  expectTtlNear,
  runSteps,
  useRedis,
  withFakeClock,
  withoutExpiry,
} from '../helpers/algorithms.js';
import { uniqueRuleId } from '../helpers/redis.js';

const r = useRedis();
const redisCounter = withFakeClock(r, createRedisSlidingWindowCounterForTest);
const counterWithoutExpiry = withoutExpiry(
  r,
  'sliding-window-counter.lua',
  'createRedisSlidingWindowCounter',
);
const W = 60_000;

describeAlgorithm('Redis sliding window counter', redisCounter, {
  burst: (rule) => rule.limit,
  // An estimate: a full previous window that all arrived at its very end still counts as spread
  // evenly, so a sliding windowMs span can see up to nearly twice the limit.
  maxPerWindow: (rule) => 2 * rule.limit,
});

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
    const expected = await runSteps(slidingWindowCounterModel(modelClock), modelClock, steps);
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

    it('waits all but the last ms of the next window when only that far in fits', async () => {
      // Found by mutation testing: fits = 1 only happens after the limit shrinks below a large
      // count, which no other test reached. Limit 8 on a 10 ms window, 6 requests at its start,
      // then the limit cut to 2. In the next window, at 9 ms in, 6 * 1/10 + 1 = 1.6 fits under
      // 2; at 8 ms in, 6 * 2/10 + 1 = 2.2 doesn't. So 10 + 9 = 19 ms, not 20.
      const { algorithm, clock } = redisCounter();
      const rule = freshRule({ limit: 8, windowMs: 10 });
      const key = buildKey(rule, 'c');
      clock.set(Math.ceil(clock.now() / 10) * 10);
      for (let i = 0; i < 6; i++) await algorithm.check(key, rule);
      expect(await algorithm.check(key, { ...rule, limit: 2 })).toStrictEqual({
        allowed: false,
        remaining: 0,
        resetMs: 19,
      });
    });

    it('looks past this window only with this window as the previous one, after a cut', async () => {
      // Found by mutation testing: nothing held case 1 to this window. Limit 8 on a 10 ms
      // window: 2 in the previous window, 4 at this one's start, then the limit cut to 4 at
      // 5 ms in. The next window counts this one's 4: 4 * (10 - 3)/10 + 1 = 3.8 fits at 3 ms in,
      // so 5 + 3 = 8 ms. Case 1's formula, run past the window with the old previous count of
      // 2, would say 10.
      const { algorithm, clock } = redisCounter();
      const rule = freshRule({ limit: 8, windowMs: 10 });
      const key = buildKey(rule, 'c');
      clock.set(Math.ceil(clock.now() / 10) * 10 + 9);
      for (let i = 0; i < 2; i++) await algorithm.check(key, rule);
      clock.advance(1);
      for (let i = 0; i < 4; i++) await algorithm.check(key, rule);
      clock.advance(5);
      expect(await algorithm.check(key, { ...rule, limit: 4 })).toStrictEqual({
        allowed: false,
        remaining: 0,
        resetMs: 8,
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

    it('matches the brute-force model on every check of 60 seeded random histories', async () => {
      // Found by mutation testing: the fixed comparison steps never reached most of the denied
      // cases, so changes to their formulas went unnoticed. Short windows and many checks reach
      // each case often, including ties and the window edges.
      const random = mulberry32(20261108);
      const pick = (n: number) => Math.floor(random() * n);
      const cases = new Set<number>();
      for (let run = 0; run < 60; run++) {
        const w = [7, 10, 16][run % 3] ?? 10;
        const rule = freshRule({ limit: 1 + pick(5), windowMs: w });
        const shorter: Rule = { ...rule, windowMs: w + 1 };
        const key = buildKey(rule, 'c');
        // Without expiry, like the model: see withoutExpiry.
        const { algorithm, clock } = counterWithoutExpiry();
        const modelClock = new FakeClock(clock.now());
        const model = slidingWindowCounterModel(modelClock);
        for (let i = 0; i < 120; i++) {
          const step = pick(4) === 0 ? pick(2 * w) : pick(3);
          clock.advance(step);
          modelClock.advance(step);
          // Now and then a second rule on the key, as in 0031.
          const checked = pick(10) === 0 ? shorter : rule;
          const got = await algorithm.check(key, checked);
          expect(got, `run ${String(run)}, check ${String(i)}`).toStrictEqual(
            await model.check(key, checked),
          );
          if (!got.allowed) cases.add(Math.sign(got.resetMs - (w - (clock.now() % w))));
        }
      }
      // Waits both inside this window and past it were seen.
      expect(cases.size).toBeGreaterThan(1);
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

  it('lets counts age out while checks alternate between two windows (0031)', async () => {
    // Two rules on one key, as during a rolling deploy. Re-aligned to each W's own windows, the
    // counts went back into the current window on every check and never aged out: 3 of 40.
    const { algorithm, clock } = redisCounter();
    const a = freshRule({ limit: 3, windowMs: 60_000 });
    const b: Rule = { ...a, windowMs: 61_000 };
    const key = buildKey(a, 'c');
    const pattern: boolean[] = [];
    for (let i = 0; i < 40; i++) {
      pattern.push((await algorithm.check(key, i % 2 === 0 ? a : b)).allowed);
      clock.advance(30_000);
    }
    // 2 a minute, under both limits. The estimate is just over 3 at some checks (2 * 31/61 + 2),
    // so a few are denied, but never two in a row.
    expect(pattern.filter(Boolean).length).toBeGreaterThanOrEqual(28);
    expect(pattern.some((ok, i) => !ok && pattern[i + 1] === false)).toBe(false);
  });

  it('keeps the old windows going when windowMs changes, so the counts keep their age', async () => {
    const { algorithm, clock } = redisCounter();
    const rule = freshRule({ limit: 5 });
    const key = buildKey(rule, 'c');
    await fillPreviousWindow(algorithm, clock, key, rule, 2);
    clock.advance(30_000);
    await algorithm.check(key, rule); // prev 2, curr 1: estimate 2 * 0.5 + 1 = 2

    // A 2-minute window from this window's start: prev weighs 90/120, so the estimate is
    // 2 * 0.75 + 1 = 2.5, and 2 more fit under 5.
    const longer = { ...rule, windowMs: 120_000 };
    expect(await allowedNow(algorithm, key, longer)).toBe(2);
    // It rolls over 2 minutes after that start, not at the epoch's 2-minute boundary: the 3 in
    // it become the previous window, weighing just under 3, so 2 fit, not 5.
    clock.advance(90_001);
    expect(await allowedNow(algorithm, key, longer)).toBe(2);
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
