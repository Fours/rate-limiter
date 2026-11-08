import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRedisSlidingWindowCounterForTest } from '../../src/algorithms/redis/sliding-window-counter.js';
import { createRedisTokenBucketForTest } from '../../src/algorithms/redis/token-bucket.js';
import { rateLimit } from '../../src/middleware.js';
import type { Rule } from '../../src/types.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { useRedis } from './helpers/algorithms.js';
import { uniqueRuleId } from './helpers/redis.js';

// Two limiters on one Redis, such as one before auth and one after, using the same rule ID
// (decision 0028). The 1.0 security review found that, without prefixes, their checks write the
// same key: on two algorithms each deletes the other's state (0016) and no request is limited.
const r = useRedis();

async function statuses(a: express.Express, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await request(a).get('/')).status);
  return out;
}

function twoLimiters(rule: Rule, prefixes: [string | undefined, string | undefined]) {
  const clock = new FakeClock(1_700_000_000_000);
  const counter = createRedisSlidingWindowCounterForTest({ client: r.client, clock });
  const bucket = createRedisTokenBucketForTest({ client: r.client, clock });
  const a = express();
  const [first, second] = prefixes;
  a.use(
    rateLimit({
      rules: [rule],
      algorithm: counter,
      identify: () => 'c',
      ...(first && { prefix: first }),
    }),
  );
  a.use(
    rateLimit({
      rules: [rule],
      algorithm: bucket,
      identify: () => 'c',
      ...(second && { prefix: second }),
    }),
  );
  a.get('/', (_req, res) => res.send('ok'));
  return a;
}

describe('prefix (decision 0028)', () => {
  it('without prefixes, two limiters with the same rule ID never limit: the bug it fixes', async () => {
    const rule: Rule = { id: uniqueRuleId('shared'), limit: 3, windowMs: 60_000 };
    expect(await statuses(twoLimiters(rule, [undefined, undefined]), 10)).not.toContain(429);
  });

  it('with a prefix each, each limiter keeps its own count, and the limit holds', async () => {
    const rule: Rule = { id: uniqueRuleId('shared'), limit: 3, windowMs: 60_000 };
    const a = twoLimiters(rule, ['preauth', undefined]);
    expect(await statuses(a, 5)).toStrictEqual([200, 200, 200, 429, 429]);
    expect(await r.redis.hget(`preauth:${rule.id}:c`, 'alg')).toBe('sliding-window-counter');
    expect(await r.redis.hget(`rl:${rule.id}:c`, 'alg')).toBe('token-bucket');
  });
});
