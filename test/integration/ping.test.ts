import { describe, expect, it } from 'vitest';
import { connectIoredis, connectNodeRedis } from './helpers/redis.js';

// The smallest proof the integration setup works: each client reaches the test Redis.
describe('test Redis', () => {
  it('answers PING through ioredis', async () => {
    const client = await connectIoredis();
    try {
      expect(await client.ping()).toBe('PONG');
    } finally {
      await client.quit();
    }
  });

  it('answers PING through node-redis', async () => {
    const client = await connectNodeRedis();
    try {
      expect(await client.ping()).toBe('PONG');
    } finally {
      await client.quit();
    }
  });
});
