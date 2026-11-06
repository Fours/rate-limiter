// A runnable demo of @kylewillett/rate-limiter. Start it with `npm run example`,
// then send requests with examples/basic/hammer.sh.
//
// It imports the package by name, exactly as an app would. Node resolves that
// name to this repo's own dist/, which `npm run example` builds first.
import express, { type Request } from 'express';
import { rateLimit, type Rule } from '@kylewillett/rate-limiter';

const rules: Rule[] = [
  // Every request: 10 per minute per client. With no API key or user, a client is its IP.
  { id: 'global', limit: 10, windowMs: 60_000 },
  // Placing orders on the free tier: 3 per minute. The most specific matching rule wins,
  // so these requests count against this rule instead of the global one.
  {
    id: 'orders:free',
    limit: 3,
    windowMs: 60_000,
    method: 'POST',
    path: '/orders/*',
    tier: 'free',
  },
];

// A stand-in for a real account lookup. Derive the tier from the client's credentials,
// never from a header that names the tier, or any client could claim to be "pro".
const proKeys = new Set(['demo-pro-key']);
function tier(req: Request): string {
  const key = req.get('x-api-key');
  return key !== undefined && proKeys.has(key) ? 'pro' : 'free';
}

const limiter = rateLimit({ rules, tier });

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
  console.log(`Listening on http://localhost:${String(port)}`);
  console.log('Try: examples/basic/hammer.sh 12');
});

// Stop the limiter's sweep timer once the server has stopped taking requests.
process.on('SIGINT', () => {
  server.close(() => {
    limiter.close();
  });
});
