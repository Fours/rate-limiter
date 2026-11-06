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
import express, { type Request } from 'express';
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
const redis = redisUrl ? new Redis(redisUrl) : undefined;
const algorithm = redis ? createAlgorithm({ client: fromIoredis(redis) }) : undefined;

// A stand-in for a real account lookup. Derive the tier from the client's credentials,
// never from a header that names the tier, or any client could claim to be "pro".
const proKeys = new Set(['demo-pro-key']);
function tier(req: Request): string {
  const key = req.get('x-api-key');
  return key !== undefined && proKeys.has(key) ? 'pro' : 'free';
}

const limiter = rateLimit({ rules, tier, ...(algorithm && { algorithm }) });

const app = express();
// Behind a load balancer or proxy, uncomment this so req.ip is the client, not the proxy.
// Only trust the hops you actually run: with `true`, a client that can reach the server
// directly can forge X-Forwarded-For and pick its own identity.
// app.set('trust proxy', 1);
app.use(limiter);

app.get('/', (_req, res) => {
  res.json({ hello: 'world' });
});
app.post('/orders', (_req, res) => {
  res.status(201).json({ ordered: true });
});

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
