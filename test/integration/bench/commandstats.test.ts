// The runner counts the limiter's Redis calls from INFO commandstats (bench/run.ts). This checks
// the parser against the real Redis's output. Other test files share this Redis and run at the
// same time, so counts are lower bounds; the exact arithmetic is in test/bench/records.test.ts.
import { createRedisTokenBucket, fromIoredis } from '@kylewillett/rate-limiter';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCommandStats, redisCallsBetween } from '../../../bench/records.ts';
import { connectIoredis, uniqueRuleId } from '../helpers/redis.js';

let redis: Redis;

beforeAll(async () => {
  redis = await connectIoredis();
});
afterAll(() => {
  redis.disconnect();
});

describe('counting Redis calls', () => {
  it("sees every check as one EVALSHA, and leaves out the runner's own INFO", async () => {
    const limiter = createRedisTokenBucket({ client: fromIoredis(redis) });
    const rule = { id: uniqueRuleId('commandstats'), limit: 100, windowMs: 60_000 };
    await limiter.check('rl:warm:up', rule); // loads the script, so later checks are EVALSHA only
    await redis.del('rl:warm:up');

    const before = parseCommandStats(await redis.info('commandstats'));
    for (let i = 0; i < 25; i++) await limiter.check(`rl:${rule.id}:c`, rule);
    const after = parseCommandStats(await redis.info('commandstats'));

    expect(after.info ?? 0).toBeGreaterThan(before.info ?? 0);
    const calls = redisCallsBetween(before, after);
    expect(calls.evalsha).toBeGreaterThanOrEqual(25);
    expect(calls).not.toHaveProperty('info');
    await redis.del(`rl:${rule.id}:c`);
  });
});
