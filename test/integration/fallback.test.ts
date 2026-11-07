import express, { type ErrorRequestHandler } from 'express';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedisTokenBucket } from '../../src/algorithms/redis/token-bucket.js';
import { rateLimit, type RateLimitMiddleware } from '../../src/middleware.js';
import { fromIoredis, fromNodeRedis, type RedisScriptClient } from '../../src/redis/client.js';
import type { Rule } from '../../src/types.js';
import { untilTimerPending } from '../helpers/timers.js';
import { closedPort, startProxy } from './helpers/proxy.js';
import { redisUrl, uniqueRuleId } from './helpers/redis.js';

// Milestone 4, T0: a real Redis client, with the settings the T0 probe recommends (offline queue
// off), against a Redis that isn't there and one that hangs. Decision 0018.

interface Connected {
  readonly client: RedisScriptClient;
  close: () => void;
}

/** The test Redis's URL, pointed at another local port: the proxy, or nothing at all. */
function urlOn(port: number): string {
  const url = new URL(redisUrl);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.toString();
}

const clients: Record<string, (port: number, wait: boolean) => Promise<Connected>> = {
  ioredis: async (port, wait) => {
    const redis = new Redis(urlOn(port), { enableOfflineQueue: false, lazyConnect: true });
    redis.on('error', () => undefined);
    const connecting = redis.connect();
    if (wait) await connecting;
    else connecting.catch(() => undefined);
    return {
      client: fromIoredis(redis),
      close: () => {
        redis.disconnect();
      },
    };
  },
  'node-redis': async (port, wait) => {
    const redis = createClient({ url: urlOn(port), disableOfflineQueue: true });
    redis.on('error', () => undefined);
    const connecting = redis.connect();
    if (wait) await connecting;
    else connecting.catch(() => undefined);
    return {
      client: fromNodeRedis(redis),
      close: () => {
        redis.destroy();
      },
    };
  },
};

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function app(limiter: RateLimitMiddleware) {
  cleanups.push(() => {
    limiter.close();
  });
  const errors: unknown[] = [];
  const a = express();
  a.use(limiter);
  a.get('/', (_req, res) => res.send('ok'));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    errors.push(err);
    res.status(500).send('error');
  };
  a.use(onError);
  return { app: a, errors };
}

describe.each(Object.keys(clients))('%s, offline queue off', (name) => {
  const connect = clients[name] as (typeof clients)[string];
  // An hour-long window, so no refill can show up between requests.
  const rule = (): Rule => ({ id: uniqueRuleId('fallback'), limit: 9, windowMs: 3_600_000 });

  it('answers from the fallback when Redis is unreachable, without waiting for the timeout', async () => {
    const { client, close } = await connect(await closedPort(), false);
    cleanups.push(close);
    // A timeout far beyond the test's own, so an answer shows the client failed fast.
    const limiter = rateLimit({
      rules: [rule()],
      algorithm: createRedisTokenBucket({ client }),
      timeoutMs: 60_000,
      fallback: { instances: 3 },
    });
    const { app: a, errors } = app(limiter);

    const res = await request(a).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('3');
    expect(errors).toStrictEqual([]);
  });

  it('answers from the fallback after timeoutMs when Redis hangs, then from Redis again', async () => {
    const target = new URL(redisUrl);
    const proxy = await startProxy({ host: target.hostname, port: Number(target.port) });
    cleanups.push(() => proxy.close());
    const { client, close } = await connect(proxy.port, true);
    cleanups.push(close);
    const limiter = rateLimit({
      rules: [rule()],
      algorithm: createRedisTokenBucket({ client }),
      fallback: { instances: 3 },
    });
    const { app: a, errors } = app(limiter);

    // Redis answers: the full limit.
    expect((await request(a).get('/')).headers['ratelimit-remaining']).toBe('8');

    // Redis hangs: after 50 ms, the fallback answers with its share of the limit.
    proxy.pause();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = request(a)
      .get('/')
      .then((res) => res);
    await untilTimerPending();
    await vi.advanceTimersByTimeAsync(50);
    const fallen = await pending;
    expect(fallen.status).toBe(200);
    expect(fallen.headers['ratelimit-limit']).toBe('3');
    vi.useRealTimers();

    // Redis answers again: the primary is back. The timed-out check reached Redis late and used
    // a token there too, so this is the third: stricter, never looser (decision 0018).
    proxy.resume();
    const back = await request(a).get('/');
    expect(back.headers['ratelimit-limit']).toBe('9');
    expect(back.headers['ratelimit-remaining']).toBe('6');
    expect(errors).toStrictEqual([]);
  });
});
