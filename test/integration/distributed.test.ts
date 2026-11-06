import type { Redis } from 'ioredis';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  InternalRedisAlgorithmOptions,
  RedisAlgorithmOptions,
} from '../../src/algorithms/redis/factory.js';
import {
  createRedisFixedWindow,
  createRedisFixedWindowForTest,
} from '../../src/algorithms/redis/fixed-window.js';
import {
  createRedisLeakyBucket,
  createRedisLeakyBucketForTest,
} from '../../src/algorithms/redis/leaky-bucket.js';
import {
  createRedisSlidingWindowCounter,
  createRedisSlidingWindowCounterForTest,
} from '../../src/algorithms/redis/sliding-window-counter.js';
import {
  createRedisSlidingWindowLog,
  createRedisSlidingWindowLogForTest,
} from '../../src/algorithms/redis/sliding-window-log.js';
import {
  createRedisTokenBucket,
  createRedisTokenBucketForTest,
} from '../../src/algorithms/redis/token-bucket.js';
import { buildKey } from '../../src/identify.js';
import { rateLimit } from '../../src/middleware.js';
import { fromIoredis, fromNodeRedis, type RedisScriptClient } from '../../src/redis/client.js';
import type { Algorithm, Rule } from '../../src/types.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { connectIoredis, connectNodeRedis, uniqueRuleId } from './helpers/redis.js';

/**
 * Several app instances sharing one Redis: the evidence for decisions 0006 (atomic Lua checks)
 * and 0007 (Redis time). Everything here goes through the public factories, which use Redis
 * TIME, except where a test deliberately uses app time to show what goes wrong.
 */

interface AlgorithmCase {
  name: string;
  public: (opts: RedisAlgorithmOptions) => Algorithm;
  forTest: (opts: InternalRedisAlgorithmOptions) => Algorithm;
  burst: (rule: Rule) => number;
}

const bursty = (rule: Rule) => rule.limit;
const algorithms: AlgorithmCase[] = [
  {
    name: 'token bucket',
    public: createRedisTokenBucket,
    forTest: createRedisTokenBucketForTest,
    burst: bursty,
  },
  {
    name: 'fixed window',
    public: createRedisFixedWindow,
    forTest: createRedisFixedWindowForTest,
    burst: bursty,
  },
  {
    name: 'sliding window log',
    public: createRedisSlidingWindowLog,
    forTest: createRedisSlidingWindowLogForTest,
    burst: bursty,
  },
  {
    name: 'sliding window counter',
    public: createRedisSlidingWindowCounter,
    forTest: createRedisSlidingWindowCounterForTest,
    burst: bursty,
  },
  {
    name: 'leaky bucket',
    public: createRedisLeakyBucket,
    forTest: createRedisLeakyBucketForTest,
    burst: (rule) => Math.ceil(rule.limit / rule.windowMs),
  },
];

// Four separate connections, two through each adapter, standing in for four app instances.
let ioredis: Redis[] = [];
let nodeRedis: Awaited<ReturnType<typeof connectNodeRedis>>[] = [];
let clients: RedisScriptClient[] = [];

beforeAll(async () => {
  ioredis = await Promise.all([connectIoredis(), connectIoredis()]);
  nodeRedis = await Promise.all([connectNodeRedis(), connectNodeRedis()]);
  clients = [...ioredis.map(fromIoredis), ...nodeRedis.map(fromNodeRedis)];
});

afterAll(async () => {
  await Promise.all([...ioredis.map((c) => c.quit()), ...nodeRedis.map((c) => c.quit())]);
});

const client = (i: number): RedisScriptClient => {
  const c = clients[i % clients.length];
  if (c === undefined) throw new Error('clients not connected');
  return c;
};

/** A window of 10^12 ms (about 32 years): epoch-aligned boundaries fall in 2001 and 2033. */
const LONG = 1_000_000_000_000;

describe('atomicity (decision 0006)', () => {
  it.each(algorithms)(
    '$name: 200 concurrent checks over 4 connections allow exactly its burst',
    async (alg) => {
      const rule: Rule = { id: uniqueRuleId('atomic'), limit: 50, windowMs: LONG };
      const key = buildKey(rule, 'c');
      const instances = [0, 1, 2, 3].map((i) => alg.public({ client: client(i) }));
      const decisions = await Promise.all(
        Array.from({ length: 200 }, (_, i) => {
          const instance = instances[i % 4];
          if (instance === undefined) throw new Error('no instance');
          return instance.check(key, rule);
        }),
      );
      expect(decisions.filter((d) => d.allowed)).toHaveLength(alg.burst(rule));
    },
  );

  it('a naive token bucket that reads, then writes in a second round trip, overshoots', async () => {
    // What every algorithm would do without a single atomic script.
    const key = buildKey({ id: uniqueRuleId('naive') }, 'c');
    const conns = ioredis.concat(ioredis); // 4 slots over the 2 ioredis connections
    const naiveCheck = async (c: Redis): Promise<boolean> => {
      const stored = await c.hget(key, 'tokens');
      const tokens = stored === null ? 50 : Number(stored);
      if (tokens < 1) return false;
      await c.hset(key, 'tokens', String(tokens - 1));
      return true;
    };
    const allowed = await Promise.all(
      Array.from({ length: 200 }, (_, i) => {
        const c = conns[i % conns.length];
        if (c === undefined) throw new Error('no connection');
        return naiveCheck(c);
      }),
    );
    // Every read lands before most writes, so far more than 50 get through (200 in testing).
    expect(allowed.filter(Boolean).length).toBeGreaterThan(50);
  });
});

describe('clock skew between instances (decision 0007)', () => {
  // 1 per 2 s. Instance A's clock is 2 s behind and B's 2 s ahead: 4 s apart, two whole windows.
  const skewRule = (): Rule => ({ id: uniqueRuleId('skew'), limit: 1, windowMs: 2_000 });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(algorithms)('$name: with app time, the skewed instance wrongly allows', async (alg) => {
    const base = Date.now();
    const a = alg.forTest({ client: client(0), clock: new FakeClock(base - 2_000) });
    const b = alg.forTest({ client: client(1), clock: new FakeClock(base + 2_000) });
    const rule = skewRule();
    const key = buildKey(rule, 'c');
    expect((await a.check(key, rule)).allowed).toBe(true);
    // A moment later in real time, B's clock says 4 s have passed.
    expect((await b.check(key, rule)).allowed).toBe(true);
  });

  it.each(algorithms)('$name: with Redis time, skewed app clocks change nothing', async (alg) => {
    // The scripts never see app time. Moving Node's own clock ±2 s around each instance's call
    // proves it: if a public factory ever read app time, B would be allowed, as above.
    vi.useFakeTimers({ toFake: ['Date'] });
    const realNow = () => Date.now();
    for (let attempt = 1; ; attempt++) {
      const a = alg.public({ client: client(0) });
      const b = alg.public({ client: client(1) });
      const rule = skewRule();
      const key = buildKey(rule, 'c');
      const before = await redisTimeMs();

      vi.setSystemTime(realNow() - 2_000);
      const first = await a.check(key, rule);
      vi.setSystemTime(realNow() + 4_000);
      const second = await b.check(key, rule);
      vi.setSystemTime(realNow() - 2_000);

      const after = await redisTimeMs();
      // A real 2 s boundary can fall between the two calls (a fraction of a percent of runs);
      // then a fixed window legitimately allows B. Retry with a fresh key.
      if (Math.floor(before / 2_000) !== Math.floor(after / 2_000) && attempt < 3) continue;
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(false);
      break;
    }
  });

  async function redisTimeMs(): Promise<number> {
    const c = ioredis[0];
    if (c === undefined) throw new Error('no connection');
    const [sec, usec] = await c.time();
    return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
  }
});

describe('two Express apps sharing one Redis', () => {
  function app(alg: AlgorithmCase, rule: Rule, connection: number) {
    const a = express();
    a.use(
      rateLimit({
        rules: [rule],
        algorithm: alg.public({ client: client(connection) }),
        identify: (req) => req.get('x-client') ?? 'none',
      }),
    );
    a.get('/', (_req, res) => {
      res.send('ok');
    });
    return a;
  }

  it.each(algorithms)('$name: a client limited on one app is limited on the other', async (alg) => {
    const rule: Rule = { id: uniqueRuleId('apps'), limit: 3, windowMs: LONG };
    const appA = app(alg, rule, 0);
    const appB = app(alg, rule, 2); // a node-redis connection, while A uses ioredis
    const as = (target: express.Express, who: string) =>
      request(target).get('/').set('x-client', who);

    for (let i = 0; i < alg.burst(rule); i++) expect((await as(appA, 'a')).status).toBe(200);
    expect((await as(appB, 'a')).status).toBe(429);
    // Another client is unaffected, on either app.
    expect((await as(appB, 'b')).status).toBe(200);

    // Alternating between the apps still allows only the burst in total.
    let allowed = 0;
    for (let i = 0; i < 8; i++) {
      if ((await as(i % 2 === 0 ? appA : appB, 'c')).status === 200) allowed++;
    }
    expect(allowed).toBe(alg.burst(rule));
  });
});
