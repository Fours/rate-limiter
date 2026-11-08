// A runnable demo of @kylewillett/rate-limiter. Start it with `npm run example`,
// then send requests with examples/basic/hammer.sh.
//
// It imports the package by name, exactly as an app would. Node resolves that
// name to this repo's own dist/, which `npm run example` builds first.
//
// Environment:
//   PORT        default 3000
//   REDIS_URL   share limits through Redis, e.g. redis://localhost:6390 (the test Redis)
//   ALGORITHM   with Redis: token-bucket, leaky-bucket, fixed-window, sliding-window-log
//               or sliding-window-counter (the default). Without Redis: token-bucket only.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import express, { type Request, type RequestHandler } from 'express';
import { Redis } from 'ioredis';
import {
  createRedisFixedWindow,
  createRedisLeakyBucket,
  createRedisSlidingWindowCounter,
  createRedisSlidingWindowLog,
  createRedisTokenBucket,
  fromIoredis,
  loadRules,
  rateLimit,
  type Algorithm,
  type RateLimitHooks,
  type RedisAlgorithmOptions,
} from '@kylewillett/rate-limiter';

const rules = await loadRules(new URL('rules.yaml', import.meta.url).pathname);

// ALGORITHM picks one for the demo. A real app would just call the one it wants.
const redisAlgorithms: Record<string, (opts: RedisAlgorithmOptions) => Algorithm> = {
  'token-bucket': createRedisTokenBucket,
  'leaky-bucket': createRedisLeakyBucket,
  'fixed-window': createRedisFixedWindow,
  'sliding-window-log': createRedisSlidingWindowLog,
  'sliding-window-counter': createRedisSlidingWindowCounter,
};

const redisUrl = process.env.REDIS_URL;
const algorithmName =
  process.env.ALGORITHM ?? (redisUrl ? 'sliding-window-counter' : 'token-bucket');
const createAlgorithm = redisAlgorithms[algorithmName];
if (createAlgorithm === undefined) {
  throw new Error(
    `Unknown ALGORITHM "${algorithmName}". Use one of: ${Object.keys(redisAlgorithms).join(', ')}`,
  );
}
if (!redisUrl && algorithmName !== 'token-bucket') {
  throw new Error(
    `ALGORITHM=${algorithmName} needs REDIS_URL. Without Redis, only token-bucket runs.`,
  );
}

// With Redis, every copy of this server shares limits. Without it, each process counts alone.
// The offline queue is off, so while Redis is unreachable each check fails at once and the
// in-memory fallback answers, instead of every request waiting out the 50 ms timeout. The retry
// cap brings the primary back within about half a second of Redis returning (decision 0010).
const redis = redisUrl
  ? new Redis(redisUrl, {
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 50, 500),
    })
  : undefined;
// ioredis reports every failed reconnect as an 'error' event, and prints any it isn't given a
// listener for. onFallback below already says when Redis is out, so keep the log to that.
redis?.on('error', () => undefined);
const algorithm = redis ? createAlgorithm({ client: fromIoredis(redis) }) : undefined;

// A stand-in for your auth middleware. A real app looks the API key up and rejects unknown ones;
// here any key starting with "demo-" is accepted. It sets req.user, which the limiter's default
// identify reads, so only keys your auth has verified get a limit of their own. The limiter never
// reads x-api-key itself: a client could send a new made-up key with every request (decision
// 0026). The account ID is a hash, so the raw key never reaches Redis.
interface Account {
  readonly id: string;
  readonly tier: 'free' | 'pro';
}
const proKeys = new Set(['demo-pro-key']);
const authenticate: RequestHandler = (req, res, next) => {
  const key = req.get('x-api-key');
  if (key === undefined) {
    next(); // No key: anonymous, so limited by IP.
    return;
  }
  if (!key.startsWith('demo-')) {
    res.status(401).json({ error: 'unknown_api_key' });
    return;
  }
  const id = `acct_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  const account: Account = { id, tier: proKeys.has(key) ? 'pro' : 'free' };
  Object.assign(req, { user: account });
  next();
};

// The tier comes from the verified account, never from a header that names the tier, or any
// client could claim to be "pro".
function tier(req: Request): string {
  return (req as Request & { user?: Account }).user?.tier ?? 'free';
}

// If Redis fails, the limiter answers from memory and calls onFallback. Logging every fallback
// would be a line per request during an outage, so this logs only the switches each way.
let onFallback = false;
const hooks: RateLimitHooks = {
  onFallback: (event) => {
    if (onFallback) return;
    onFallback = true;
    const why = event.reason === 'timeout' ? 'timed out' : `failed: ${String(event.error)}`;
    console.warn(`Redis check ${why}. Answering from the in-memory fallback.`);
  },
  onDecision: (event) => {
    if (onFallback && event.source === 'primary') {
      onFallback = false;
      console.warn('Redis is answering again.');
    }
  },
};

const limiter = rateLimit({ rules, tier, hooks, ...(algorithm && { algorithm }) });

const app = express();
// Behind a load balancer or proxy, uncomment this so req.ip is the client, not the proxy.
// Only trust the hops you actually run: with `true`, a client that can reach the server
// directly can forge X-Forwarded-For and pick its own identity.
// app.set('trust proxy', 1);
app.use(authenticate);
app.use(limiter);

app.get('/', (_req, res) => {
  res.json({ hello: 'world' });
});
app.post('/orders', (_req, res) => {
  res.status(201).json({ ordered: true });
});

// With the offline queue off, a check sent before the client connects falls back. Wait for the
// connection before taking requests, but not forever: if Redis is down, start anyway and let the
// fallback answer.
if (redis) {
  await Promise.race([new Promise((resolve) => redis.once('ready', resolve)), delay(2000)]);
}

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  const store = redisUrl ? `Redis at ${redisUrl}` : 'memory, in this process only';
  console.log(`Listening on http://localhost:${String(port)}: ${algorithmName}, in ${store}`);
  console.log('Try: examples/basic/hammer.sh 12');
});

// Once the server has stopped taking requests, stop the limiter's sweep timer and disconnect.
function shutdown() {
  server.close(() => {
    limiter.close();
    redis?.disconnect();
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
