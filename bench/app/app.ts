// The benchmark app (milestone 3). Unlike examples/basic, it's built for measuring: a no-limiter
// baseline, a route that does no work, and a Server-Timing header with the limiter's own cost.
//
// It imports the package by name, as an app would. In the Docker image that's the built dist/;
// in tests, vitest.config.ts points the name at src/.
import { createHash } from 'node:crypto';
import express, { type Express, type Request, type RequestHandler } from 'express';
import { Redis } from 'ioredis';
import { Registry } from 'prom-client';
import {
  createRedisFixedWindow,
  createRedisLeakyBucket,
  createRedisSlidingWindowCounter,
  createRedisSlidingWindowLog,
  createRedisTokenBucket,
  defaultIdentify,
  fromIoredis,
  rateLimit,
  type Algorithm,
  type DecisionEvent,
  type FallbackEvent,
  type RateLimitHooks,
  type RedisAlgorithmOptions,
  type Rule,
} from '@kylewillett/rate-limiter';
import { prometheusHooks } from '@kylewillett/rate-limiter/prometheus';

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
  /**
   * Records decisions through prometheusHooks() and serves them at GET /metrics. Off by default,
   * so benchmarks without it measure the limiter alone, as in milestone 3.
   */
  readonly metrics?: boolean;
  /** The fallback's instance count (decision 0018): the stack runs 3. Default 1. */
  readonly fallbackInstances?: number;
  /** Where the switches between primary and fallback are logged. Default console.log. */
  readonly log?: (line: string) => void;
}

export interface BenchApp {
  readonly app: Express;
  /**
   * Resolves once the Redis client is connected. With the offline queue off, ioredis refuses
   * commands until then, so a check sent earlier falls back. Tests wait for this; the server
   * doesn't, so the app still starts and answers /healthz without Redis.
   */
  ready(): Promise<void>;
  /** Disconnects from Redis. Call it after the HTTP server has closed. */
  close(): void;
}

/**
 * k6 simulates many clients from one machine, each sending its own `x-api-key`. The library never
 * trusts that header (decision 0026), so the harness reads it here, where every client is made up
 * anyway. A real app must check a key before limiting by it. The ID keeps the `key_` plus 16 hex
 * form the library used before 0026, so 0008's memory per key stays comparable.
 */
export function benchIdentify(req: Request): string {
  const key = req.get('x-api-key');
  return key === undefined || key === '' ? defaultIdentify(req) : benchClientId(key);
}

/** The client ID for a simulated client's `x-api-key`. */
export function benchClientId(apiKey: string): string {
  return `key_${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}

/** Throws on a bad option, so a misconfigured instance fails at startup, not under load. */
export function createApp(opts: BenchAppOptions): BenchApp {
  if (!ALGORITHMS.includes(opts.algorithm)) {
    throw new Error(`Unknown ALGORITHM "${opts.algorithm}". Use one of: ${ALGORITHMS.join(', ')}`);
  }
  const factory = factories[opts.algorithm];
  let redis: Redis | undefined;
  let limiter: RequestHandler | undefined;
  // One registry per app, not prom-client's global one, so tests can run several apps at once.
  const registry = opts.metrics === true ? new Registry() : undefined;
  if (factory !== undefined) {
    if (opts.redisUrl === undefined || opts.redisUrl === '') {
      throw new Error(`ALGORITHM=${opts.algorithm} needs REDIS_URL`);
    }
    // The offline queue off, as decision 0018 recommends: while Redis is down, a check fails at
    // once and the fallback answers, instead of waiting out the timeout in ioredis's queue.
    redis = new Redis(opts.redisUrl, { enableOfflineQueue: false });
    limiter = rateLimit({
      rules: opts.rules,
      algorithm: factory({ client: fromIoredis(redis) }),
      identify: benchIdentify,
      fallback: { instances: opts.fallbackInstances ?? 1 },
      hooks: benchHooks(
        opts.instance,
        opts.log ?? console.log,
        registry === undefined ? undefined : prometheusHooks({ registry }),
      ),
    });
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
  // Also before the limiter: Prometheus scrapes each instance every few seconds, and a scrape
  // must neither use up a limit nor show up as a decision.
  if (registry !== undefined) {
    app.get('/metrics', async (_req, res) => {
      res.type(registry.contentType).send(await registry.metrics());
    });
  }
  if (limiter !== undefined) app.use(timed(limiter));
  // Does no work, so the numbers measure the limiter rather than a handler.
  app.get('/work', (_req, res) => {
    res.json({ ok: true });
  });

  const client = redis;
  return {
    app,
    ready: () =>
      client === undefined || client.status === 'ready'
        ? Promise.resolve()
        : new Promise((resolve) => {
            client.once('ready', () => {
              resolve();
            });
          }),
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

/** Anything but 1, 0 or unset fails at startup, so a typo can't quietly turn metrics off. */
export function parseMetrics(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`METRICS must be 1 or 0, not "${value}"`);
}

/**
 * The app's own hooks, around prometheusHooks() when METRICS=1.
 *
 * - X-RateLimit-Source says which source decided, so the chaos benchmark can time how long the
 *   primary takes to come back after Redis does (milestone 4, T4).
 * - Only switches are logged, from the primary to the fallback and back: one line per outage
 *   per instance, rather than one per request.
 */
export function benchHooks(
  instance: string,
  log: (line: string) => void,
  metrics: RateLimitHooks | undefined,
): RateLimitHooks {
  let source: 'primary' | 'fallback' = 'primary';
  return {
    onFallback: (event: FallbackEvent) => {
      if (source === 'primary') {
        source = 'fallback';
        const why = event.reason === 'error' ? `error: ${errorMessage(event.error)}` : 'timeout';
        log(`${instance}: Redis check failed (${why}); answering from the in-memory fallback`);
      }
      metrics?.onFallback?.(event);
    },
    onDecision: (event: DecisionEvent) => {
      event.req.res?.setHeader('X-RateLimit-Source', event.source);
      if (event.source === 'primary' && source === 'fallback') {
        source = 'primary';
        log(`${instance}: Redis answering again; back on the primary`);
      }
      metrics?.onDecision?.(event);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** FALLBACK_INSTANCES: a positive integer, or unset for 1. Anything else fails at startup. */
export function parseInstances(value: string | undefined): number {
  if (value === undefined || value === '') return 1;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`FALLBACK_INSTANCES must be a positive integer, not "${value}"`);
  }
  return Number(value);
}
