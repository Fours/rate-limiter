// The benchmark app (milestone 3). Unlike examples/basic, it's built for measuring: a no-limiter
// baseline, a route that does no work, and a Server-Timing header with the limiter's own cost.
//
// It imports the package by name, as an app would. In the Docker image that's the built dist/;
// in tests, vitest.config.ts points the name at src/.
import express, { type Express, type RequestHandler } from 'express';
import { Redis } from 'ioredis';
import {
  createRedisFixedWindow,
  createRedisLeakyBucket,
  createRedisSlidingWindowCounter,
  createRedisSlidingWindowLog,
  createRedisTokenBucket,
  fromIoredis,
  rateLimit,
  type Algorithm,
  type RedisAlgorithmOptions,
  type Rule,
} from '@kylewillett/rate-limiter';

const factories: Readonly<Record<string, (opts: RedisAlgorithmOptions) => Algorithm>> = {
  'token-bucket': createRedisTokenBucket,
  'leaky-bucket': createRedisLeakyBucket,
  'fixed-window': createRedisFixedWindow,
  'sliding-window-log': createRedisSlidingWindowLog,
  'sliding-window-counter': createRedisSlidingWindowCounter,
};

/** Every value ALGORITHM accepts. `none` mounts no limiter: the baseline for added latency. */
export const ALGORITHMS = [...Object.keys(factories), 'none'] as const;

export interface BenchAppOptions {
  readonly algorithm: string;
  readonly rules: readonly Rule[];
  /** Sent back as X-Instance, so callers can see which instance served them. */
  readonly instance: string;
  /** Required unless algorithm is `none`. */
  readonly redisUrl?: string | undefined;
}

export interface BenchApp {
  readonly app: Express;
  /** Disconnects from Redis. Call it after the HTTP server has closed. */
  close(): void;
}

/** Throws on a bad option, so a misconfigured instance fails at startup, not under load. */
export function createApp(opts: BenchAppOptions): BenchApp {
  if (!ALGORITHMS.includes(opts.algorithm)) {
    throw new Error(`Unknown ALGORITHM "${opts.algorithm}". Use one of: ${ALGORITHMS.join(', ')}`);
  }
  const factory = factories[opts.algorithm];
  let redis: Redis | undefined;
  let limiter: RequestHandler | undefined;
  if (factory !== undefined) {
    if (opts.redisUrl === undefined || opts.redisUrl === '') {
      throw new Error(`ALGORITHM=${opts.algorithm} needs REDIS_URL`);
    }
    redis = new Redis(opts.redisUrl);
    limiter = rateLimit({ rules: opts.rules, algorithm: factory({ client: fromIoredis(redis) }) });
  }

  const app = express();
  // nginx sits in front in the stack (one hop), so req.ip is the client, not nginx.
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.set('X-Instance', opts.instance);
    // When this instance received the request, epoch ms. The benchmarks time windows by it, not
    // by k6's send time, because it's far closer to when the limiter decided. It's Date.now(),
    // the same wall clock Redis TIME reads, and in whole ms like Redis. performance.timeOrigin +
    // now() is finer, but it's a monotonic clock anchored at process start: a probe in T3 saw it
    // wander 0.3 to 1.3 ms from the wall clock as Docker's VM corrected its time, differently in
    // each instance (decision 0017).
    res.set('X-Received-At', String(Date.now()));
    next();
  });
  // Before the limiter, so health checks and k6 setup never use up a client's limit.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  if (limiter !== undefined) app.use(timed(limiter));
  // Does no work, so the numbers measure the limiter rather than a handler.
  app.get('/work', (_req, res) => {
    res.json({ ok: true });
  });

  return {
    app,
    close: () => {
      redis?.disconnect();
    },
  };
}

/**
 * Wraps a middleware so the response carries `Server-Timing: rl;dur=<ms>`: the time from
 * entering it to its `next()`, or to it starting to write a response itself (a 429). The header
 * is added in writeHead, which Express 5 calls for every response (checked by a probe, and by
 * the 429 test), because on a 429 the limiter has already sent the response when it returns.
 */
function timed(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    let end: number | undefined;
    const writeHead = res.writeHead.bind(res);
    res.writeHead = ((...args: Parameters<typeof writeHead>) => {
      const dur = (end ?? performance.now()) - start;
      res.setHeader('Server-Timing', `rl;dur=${dur.toFixed(3)}`);
      return writeHead(...args);
    }) as typeof writeHead;
    return middleware(req, res, (err?: unknown) => {
      end = performance.now();
      next(err);
    });
  };
}
