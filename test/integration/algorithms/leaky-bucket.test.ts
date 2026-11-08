import { describe, expect, it } from 'vitest';
import { createRedisFixedWindowForTest } from '../../../src/algorithms/redis/fixed-window.js';
import {
  createRedisLeakyBucket,
  createRedisLeakyBucketForTest,
} from '../../../src/algorithms/redis/leaky-bucket.js';
import { createRedisSlidingWindowCounterForTest } from '../../../src/algorithms/redis/sliding-window-counter.js';
import { createRedisSlidingWindowLogForTest } from '../../../src/algorithms/redis/sliding-window-log.js';
import { createRedisTokenBucketForTest } from '../../../src/algorithms/redis/token-bucket.js';
import { buildKey } from '../../../src/identify.js';
import type { RedisScriptClient } from '../../../src/redis/client.js';
import type { Algorithm, Rule } from '../../../src/types.js';
import { describeAlgorithm } from '../../contract/algorithm-contract.js';
import { FakeClock } from '../../helpers/fake-clock.js';
import { leakyBucketModel } from '../../helpers/models.js';
import {
  burstSteps,
  comparisonSteps,
  expectTtlNear,
  runSteps,
  useRedis,
  withFakeClock,
  withoutExpiry,
} from '../helpers/algorithms.js';
import { uniqueRuleId } from '../helpers/redis.js';

const r = useRedis();
const redisLeaky = withFakeClock(r, createRedisLeakyBucketForTest);
const leakyWithoutExpiry = withoutExpiry(r, 'leaky-bucket.lua', 'createRedisLeakyBucket', true);

describeAlgorithm('Redis leaky bucket', redisLeaky, {
  // No burst: one at a time, unless the rule is faster than one per ms.
  burst: (rule) => Math.ceil(rule.limit / rule.windowMs),
  // Evenly spaced, so never more than the limit in any window.
  maxPerWindow: (rule) => rule.limit,
});

function freshRule(overrides: Partial<Omit<Rule, 'id'>> = {}): Rule {
  return { id: uniqueRuleId('leaky'), limit: 4, windowMs: 60_000, ...overrides };
}

/** Requests as fast as allowed, jumping by each denial's resetMs; returns the allowed times. */
async function allowedTimes(algorithm: Algorithm, clock: FakeClock, rule: Rule, count: number) {
  const key = buildKey(rule, 'c');
  const start = clock.now();
  const times: number[] = [];
  while (times.length < count) {
    const decision = await algorithm.check(key, rule);
    if (decision.allowed) times.push(clock.now() - start);
    else clock.advance(decision.resetMs);
  }
  return times;
}

describe('Redis leaky bucket', () => {
  it('returns exactly the same decisions as the reference model, step for step', async () => {
    const steps = comparisonSteps();
    const modelClock = new FakeClock();
    const expected = await runSteps(leakyBucketModel(modelClock), modelClock, steps);
    const { algorithm, clock } = redisLeaky();
    expect(await runSteps(algorithm, clock, steps)).toStrictEqual(expected);
    expect(expected.some((d) => !d.allowed)).toBe(true);
  });

  it('returns exactly the same decisions as the reference model, with bursts', async () => {
    const steps = burstSteps();
    const modelClock = new FakeClock();
    const expected = await runSteps(leakyBucketModel(modelClock), modelClock, steps);
    const { algorithm, clock } = redisLeaky();
    expect(await runSteps(algorithm, clock, steps)).toStrictEqual(expected);
    expect(expected.some((d) => !d.allowed)).toBe(true);
    expect(expected.some((d) => d.remaining > 5)).toBe(true); // a burst above the limit
  });

  it('says it takes a burst', () => {
    expect(createRedisLeakyBucket({ client: r.client }).supportsBurst).toBe(true);
  });

  it('with a burst, allows that many at once, then one every interval', async () => {
    const { algorithm, clock } = redisLeaky();
    // 4 per minute, 3 at once: then one every 15 s.
    const rule = freshRule({ burst: 3 });
    const key = buildKey(rule, 'c');
    expect(await algorithm.check(key, rule)).toStrictEqual({
      allowed: true,
      remaining: 2,
      resetMs: 15_000,
    });
    expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 0 });
    // Fully drained 45 s from now; the next slot, brought forward by 30 s, starts in 15 s.
    expect(await algorithm.check(key, rule)).toStrictEqual({
      allowed: false,
      remaining: 0,
      resetMs: 15_000,
    });
    clock.advance(14_999);
    expect((await algorithm.check(key, rule)).allowed).toBe(false);
    clock.advance(1);
    expect(await algorithm.check(key, rule)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('with a burst, keeps slots exact when the interval is not a whole number of ms', async () => {
    const { algorithm, clock } = redisLeaky();
    // 7 per minute, 2 at once: two at 0, then one every 8571.43 ms after the second slot.
    expect(
      await allowedTimes(algorithm, clock, freshRule({ limit: 7, burst: 2 }), 6),
    ).toStrictEqual([0, 0, 8_571, 17_142, 25_714, 34_285]);
  });

  it('never allows more than the new burst when it changes under a stored key', async () => {
    const { algorithm, clock } = redisLeaky();
    const rule = freshRule({ limit: 60, burst: 5 }); // one a second, 5 at once
    const key = buildKey(rule, 'c');
    for (let i = 0; i < 5; i++) await algorithm.check(key, rule);
    // Cut to 2 while 5 slots ahead: nothing until the debt is down to 1 slot, 4 s from now.
    const cut = { ...rule, burst: 2 };
    expect(await algorithm.check(key, cut)).toMatchObject({ allowed: false, resetMs: 4_000 });
    // Raised to 8: the debt is kept, so 3 more at once, and no more than 8 in all.
    const raised = { ...rule, burst: 8 };
    expect(await algorithm.check(key, raised)).toMatchObject({ allowed: true, remaining: 2 });
    clock.advance(3_600_000);
    let allowed = 0;
    while ((await algorithm.check(key, raised)).allowed) allowed++;
    expect(allowed).toBe(8);
  });

  it('spaces requests evenly: 4 per minute, asked every second, gets one every 15 s', async () => {
    const { algorithm, clock } = redisLeaky();
    const rule = freshRule();
    const key = buildKey(rule, 'c');
    const allowedAt: number[] = [];
    for (let s = 0; s <= 75; s++) {
      if ((await algorithm.check(key, rule)).allowed) allowedAt.push(s);
      clock.advance(1_000);
    }
    expect(allowedAt).toStrictEqual([0, 15, 30, 45, 60, 75]);
  });

  it('has no burst: a new client gets one request, then waits a full interval', async () => {
    const { algorithm } = redisLeaky();
    const rule = freshRule();
    const key = buildKey(rule, 'c');
    expect(await algorithm.check(key, rule)).toStrictEqual({
      allowed: true,
      remaining: 0,
      resetMs: 15_000,
    });
    expect(await algorithm.check(key, rule)).toStrictEqual({
      allowed: false,
      remaining: 0,
      resetMs: 15_000,
    });
  });

  it('does not drift when the interval is not a whole number of ms: 7 per minute', async () => {
    const { algorithm, clock } = redisLeaky();
    // 60 000 / 7 = 8571.43 ms. Each slot starts within the ms shown; the eighth lands on 60 000.
    expect(await allowedTimes(algorithm, clock, freshRule({ limit: 7 }), 8)).toStrictEqual([
      0, 8_571, 17_142, 25_714, 34_285, 42_857, 51_428, 60_000,
    ]);
  });

  describe('a rule faster than one request per ms: 10 per 4 ms', () => {
    // The script expires a key when its bucket drains, by Redis's real clock: as little as 1 ms
    // here. These tests move a fake clock, so on a slow machine the key could expire between two
    // checks and the bucket restart. A PERSIST sent after each check wasn't enough: on CI the
    // key sometimes expired before the PERSIST arrived. So each check runs in one MULTI with its
    // PERSIST, and the key never has a TTL between checks. These tests are about the slot
    // arithmetic; expiry has its own tests above.
    function persisting(): { algorithm: Algorithm; clock: FakeClock } {
      const run = async (
        cmd: 'evalsha' | 'eval',
        first: string,
        keys: string[],
        args: string[],
      ) => {
        const key = keys[0] ?? '';
        const results = await r.redis
          .multi()
          [cmd](first, keys.length, ...keys, ...args)
          .persist(key)
          .exec();
        const [error, value] = results?.[0] ?? [new Error('MULTI was discarded'), undefined];
        // Rethrown as is, so a NOSCRIPT error still makes the factory load the script.
        if (error) throw error;
        return value;
      };
      const client: RedisScriptClient = {
        evalsha: (sha, keys, args) => run('evalsha', sha, keys, args),
        eval: (script, keys, args) => run('eval', script, keys, args),
      };
      const clock = new FakeClock();
      return { algorithm: createRedisLeakyBucketForTest({ client, clock }), clock };
    }
    const check = (algorithm: Algorithm, key: string, rule: Rule) => algorithm.check(key, rule);

    it('allows the slots that start within this ms, counting remaining down', async () => {
      const { algorithm } = persisting();
      const rule = freshRule({ limit: 10, windowMs: 4 });
      const key = buildKey(rule, 'c');
      // Slots at 0, 0.4 and 0.8 ms all start within the first millisecond.
      const decisions = [];
      for (let i = 0; i < 4; i++) decisions.push(await check(algorithm, key, rule));
      expect(decisions.map((d) => [d.allowed, d.remaining])).toStrictEqual([
        [true, 2],
        [true, 1],
        [true, 0],
        [false, 0],
      ]);
      expect(decisions[3]?.resetMs).toBe(1);
    });

    it('allows exactly 10 in 4 ms', async () => {
      const { algorithm, clock } = persisting();
      const rule = freshRule({ limit: 10, windowMs: 4 });
      const key = buildKey(rule, 'c');
      let allowed = 0;
      for (let ms = 0; ms < 4; ms++) {
        while ((await check(algorithm, key, rule)).allowed) allowed++;
        clock.advance(1);
      }
      expect(allowed).toBe(10);
    });
  });

  it('matches the exact model on every check of 60 seeded random histories', async () => {
    // Found by mutation testing: the fixed steps never reached a remainder of exactly 1 on a
    // rule change, or exactly 1 unit of room, so changes at those edges went unnoticed.
    let seed = 20261108;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = (n: number) => Math.floor(random() * n);
    for (let run = 0; run < 60; run++) {
      const windowMs = [1, 3, 7, 10][run % 4] ?? 10;
      const id = uniqueRuleId('leaky-dense');
      const randomRule = (): Rule => ({
        id,
        limit: 1 + pick(12),
        windowMs,
        ...(pick(2) === 0 ? {} : { burst: 1 + pick(4) }),
      });
      // A second rule on the same key, now and then, as in 0031.
      const rule = randomRule();
      const other = randomRule();
      const key = buildKey(rule, 'c');
      // Without expiry, like the model: see withoutExpiry.
      const { algorithm, clock } = leakyWithoutExpiry();
      const modelClock = new FakeClock(clock.now());
      const model = leakyBucketModel(modelClock);
      for (let i = 0; i < 120; i++) {
        const step = pick(4) === 0 ? pick(3 * windowMs) : pick(2);
        clock.advance(step);
        modelClock.advance(step);
        const checked = pick(8) === 0 ? other : rule;
        expect(
          await algorithm.check(key, checked),
          `run ${String(run)}, check ${String(i)}`,
        ).toStrictEqual(await model.check(key, checked));
      }
    }
  });

  it('never brings the next slot earlier when the rule changes', async () => {
    const { algorithm } = redisLeaky();
    const rule = freshRule({ limit: 7 });
    const key = buildKey(rule, 'c');
    await algorithm.check(key, rule); // next slot at 8571.43 ms, which would be allowed at 8 571
    // The remainder is in 1/7 ms; under the new rule the slot rounds up to 8 572.
    expect(await algorithm.check(key, { ...rule, limit: 6 })).toStrictEqual({
      allowed: false,
      remaining: 0,
      resetMs: 8_572,
    });
  });

  describe('expiry', () => {
    it('sets the TTL to when the bucket has drained', async () => {
      const { algorithm } = redisLeaky();
      const rule = freshRule({ limit: 7 });
      const key = buildKey(rule, 'c');
      await algorithm.check(key, rule);
      // Drained once 8571.43 ms have passed: the start of ms 8 572.
      await expectTtlNear(r.redis, key, 8_572);
    });

    it('loses nothing when the key expires: a deleted key gives the same answer as a kept one', async () => {
      const { algorithm, clock } = redisLeaky();
      const rule = freshRule({ limit: 7 });
      const kept = buildKey(rule, 'kept');
      const expired = buildKey(rule, 'expired');
      await algorithm.check(kept, rule);
      const last = await algorithm.check(expired, rule);
      clock.advance(last.resetMs);
      await r.redis.del(expired); // what Redis does when the TTL runs out
      expect(await algorithm.check(expired, rule)).toStrictEqual(await algorithm.check(kept, rule));
    });
  });

  describe('switching algorithms (decision 0016)', () => {
    const others = [
      ['token bucket', createRedisTokenBucketForTest],
      ['fixed window', createRedisFixedWindowForTest],
      ['sliding window log', createRedisSlidingWindowLogForTest],
      ['sliding window counter', createRedisSlidingWindowCounterForTest],
    ] as const;
    it.each(
      others.flatMap(([name, other]) => [
        [`${name} to leaky bucket`, other, createRedisLeakyBucketForTest],
        [`leaky bucket to ${name}`, createRedisLeakyBucketForTest, other],
      ]),
    )('%s starts the client fresh, with no WRONGTYPE error', async (_label, before, after) => {
      const clock = new FakeClock();
      const old = before({ client: r.client, clock });
      const next = after({ client: r.client, clock });
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      while ((await old.check(key, rule)).allowed) {
        // use up whatever the old algorithm allows
      }
      expect((await next.check(key, rule)).allowed).toBe(true);
    });

    it('starts fresh over a token-bucket hash, which shares the limit, window and last fields', async () => {
      const { algorithm, clock } = redisLeaky();
      const rule = freshRule();
      const key = buildKey(rule, 'c');
      const later = String(clock.now() + 50_000);
      // Shaped like a leaky bucket waiting 50 s, but tagged as the token bucket's.
      await r.redis.hset(
        key,
        'alg',
        'token-bucket',
        'tat',
        later,
        'rem',
        '0',
        'limit',
        '4',
        'window',
        '60000',
        'last',
        String(clock.now()),
      );
      expect((await algorithm.check(key, rule)).allowed).toBe(true);
    });
  });

  it('uses Redis time when built through the public factory', async () => {
    const algorithm = createRedisLeakyBucket({ client: r.client });
    const rule = freshRule({ limit: 3, windowMs: 1_000_000_000_000 });
    const key = buildKey(rule, 'c');
    const results: boolean[] = [];
    for (let i = 0; i < 3; i++) results.push((await algorithm.check(key, rule)).allowed);
    expect(results).toStrictEqual([true, false, false]);
  });
});
