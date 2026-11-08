import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createClient } from 'redis';

/** The test Redis from docker-compose.test.yml. Port 6390 keeps tests away from any other Redis. */
export const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';

export async function connectIoredis(options: { stringNumbers?: boolean } = {}): Promise<Redis> {
  const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, ...options });
  await client.connect();
  return client;
}

// Return type inferred: node-redis's generics don't survive ReturnType<typeof createClient>.
export async function connectNodeRedis() {
  const client = createClient({ url: redisUrl });
  await client.connect();
  return client;
}

/**
 * A rule id no other test uses. Test files run in parallel against one Redis, and tests never
 * flush it (it might not be ours), so unique keys are what keeps them apart.
 */
export function uniqueRuleId(name: string): string {
  return `test:${name}:${randomUUID()}`;
}
