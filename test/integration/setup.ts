import { createClient } from 'redis';
import { redisUrl } from './helpers/redis.js';

const MIN_MAJOR_VERSION = 7;

/**
 * Runs once before the integration tests. Fails loudly rather than skipping, so a run with no
 * Redis can never look like a pass.
 */
export default async function setup(): Promise<void> {
  // No reconnects: a dead URL should fail at once, not retry in the background and hang the run.
  const client = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false, connectTimeout: 3_000 },
  });
  // Without a listener, node-redis rethrows connection errors as unhandled 'error' events.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `No Redis at ${redisUrl}. Start the test Redis with: npm run redis:up ` +
        `(or set REDIS_URL). Cause: ${String(err)}`,
      { cause: err },
    );
  }
  try {
    const info = await client.info('server');
    const version = /redis_version:(\d+)\./.exec(info)?.[1];
    // Scripts read TIME and then write, which needs Redis 7's script effects replication (0007).
    if (version === undefined || Number(version) < MIN_MAJOR_VERSION) {
      throw new Error(
        `Redis ${String(MIN_MAJOR_VERSION)} or later is required, found ${version ?? 'unknown'}`,
      );
    }
  } finally {
    await client.quit();
  }
}
