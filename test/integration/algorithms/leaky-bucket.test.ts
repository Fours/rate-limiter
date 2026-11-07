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
const redisLeaky = withFakeClock(r, createRedisLeakyBucketForTest);

describeAlgorithm('Redis leaky bucket', redisLeaky, {
  // No burst: one at a time, unless the rule is faster than one per ms.
  burst: (rule) => Math.ceil(rule.limit / rule.windowMs),
  // Evenly spaced, so never more than the limit in any window.
  maxPerWindow: (rule) => rule.limit,
});

/**
 * The same rules as leaky-bucket.lua, but with the TAT as one exact fraction (a BigInt count of
 * 1/limit ms) instead of whole ms plus a remainder, so the script's carrying is checked
 * independently.
 */
function referenceModel(clock: FakeClock): Algorithm {
  const state = new Map<string, { n: bigint; limit: bigint; window: bigint; last: number }>();
  const floorDiv = (a: bigint, b: bigint) => a / b; // a, b >= 0 here
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  return {
    check(key: string, rule: Rule): Promise<Decision> {
      const limit = BigInt(rule.limit);
      const window = BigInt(rule.windowMs);
      const stored = state.get(key);
      const now = Math.max(clock.now(), stored?.last ?? Number.NEGATIVE_INFINITY);
      const nowN = BigInt(now) * limit;
      let n = nowN;
      if (stored !== undefined) {
        n = stored.n;
        if (stored.limit !== limit || stored.window !== window) {
          n = ceilDiv(n, stored.limit) * limit; // round up to a whole ms
        }
      }
      if (floorDiv(n, limit) < BigInt(now)) n = nowN;

      const allowed = floorDiv(n, limit) <= BigInt(now);
      if (allowed) n += window;
      state.set(key, { n, limit, window, last: now });

      const room = BigInt(now + 1) * limit - n;
      const remaining = room > 0n ? Number(ceilDiv(room, window)) : 0;
      const resetMs = Number(allowed ? ceilDiv(n, limit) : floorDiv(n, limit)) - now;
      return Promise.resolve({ allowed, remaining, resetMs });
    },
  };
}

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
    const expected = await runSteps(referenceModel(modelClock), modelClock, steps);
    const { algorithm, clock } = redisLeaky();
    expect(await runSteps(algorithm, clock, steps)).toStrictEqual(expected);
    expect(expected.some((d) => !d.allowed)).toBe(true);
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
