import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRedisFixedWindowForTest } from '../../src/algorithms/redis/fixed-window.js';
import { createRedisSlidingWindowLogForTest } from '../../src/algorithms/redis/sliding-window-log.js';
import { rateLimit, type RateLimitOptions } from '../../src/middleware.js';
import type { Rule } from '../../src/types.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { useRedis } from './helpers/algorithms.js';
import { uniqueRuleId } from './helpers/redis.js';

// Per-rule algorithms (decision 0023) against the test Redis: rules on different algorithms side
// by side in one middleware, and a rule moved from one algorithm to another (decision 0016).
const r = useRedis();
const W = 10_000;

function app(opts: RateLimitOptions) {
  const a = express();
  a.use(rateLimit({ identify: () => 'c', ...opts }));
  a.all('/{*rest}', (_req, res) => res.send('ok'));
  return a;
}

async function statuses(a: express.Express, path: string, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await request(a).get(path)).status);
  return out;
}

describe('algorithm per rule, on Redis', () => {
  it('runs two rules on two algorithms in one Redis, each as its algorithm should', async () => {
    // A second before a fixed-window boundary.
    const clock = new FakeClock(1_700_000_000_000 - 1_000);
    const fixed = createRedisFixedWindowForTest({ client: r.client, clock });
    const log = createRedisSlidingWindowLogForTest({ client: r.client, clock });
    const win: Rule = {
      id: uniqueRuleId('win'),
      limit: 3,
      windowMs: W,
      path: '/win',
      algorithm: 'fixed',
    };
    const exact: Rule = {
      id: uniqueRuleId('log'),
      limit: 3,
      windowMs: W,
      path: '/log',
      algorithm: 'log',
    };
    const a = app({ rules: [win, exact], algorithms: { fixed, log } });

    expect(await statuses(a, '/win', 4)).toStrictEqual([200, 200, 200, 429]);
    expect(await statuses(a, '/log', 4)).toStrictEqual([200, 200, 200, 429]);

    // Across the boundary the fixed window starts again; the log still counts the last 10 s.
    clock.advance(1_000);
    expect(await statuses(a, '/win', 4)).toStrictEqual([200, 200, 200, 429]);
    expect(await statuses(a, '/log', 1)).toStrictEqual([429]);

    // Each key holds what its own algorithm stores.
    expect(await r.redis.type(`rl:${win.id}:c`)).toBe('hash');
    expect(await r.redis.hget(`rl:${win.id}:c`, 'alg')).toBe('fixed-window');
    expect(await r.redis.type(`rl:${exact.id}:c`)).toBe('zset');
  });

  it('starts a client fresh, once, when its rule moves to another algorithm', async () => {
    const clock = new FakeClock();
    const fixed = createRedisFixedWindowForTest({ client: r.client, clock });
    const log = createRedisSlidingWindowLogForTest({ client: r.client, clock });
    const rule: Rule = { id: uniqueRuleId('moved'), limit: 2, windowMs: 60_000 };

    const before = app({ rules: [{ ...rule, algorithm: 'fixed' }], algorithms: { fixed, log } });
    expect(await statuses(before, '/', 3)).toStrictEqual([200, 200, 429]);

    // The operator moves the rule to the log: same ID, so the same key, and the fixed window's
    // state is under it. The log claims the key and the client gets its limit again, once.
    const after = app({ rules: [{ ...rule, algorithm: 'log' }], algorithms: { fixed, log } });
    expect(await statuses(after, '/', 3)).toStrictEqual([200, 200, 429]);
    expect(await r.redis.type(`rl:${rule.id}:c`)).toBe('zset');
  });
});
