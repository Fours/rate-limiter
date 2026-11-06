import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createMatcher } from '../src/rules.js';
import type { Rule } from '../src/types.js';

// Runs the matcher inside a real Express app, so the req.baseUrl / req.path shapes the
// matcher relies on are checked against Express itself rather than assumed.
const base = { limit: 10, windowMs: 1_000 };
const rules: Rule[] = [
  { id: 'api-orders-get', ...base, path: '/api/orders', method: 'GET' },
  { id: 'api-orders-any', ...base, path: '/api/orders/*' },
  { id: 'api-root', ...base, path: '/api' },
];

function appWithMatcherIn(where: 'app' | 'router') {
  const match = createMatcher(rules);
  const tag: RequestHandler = (req, res, next) => {
    res.set('X-Rule', match(req, undefined)?.id ?? 'none');
    next();
  };

  const router = express.Router();
  if (where === 'router') router.use(tag);
  router.get('/', (_req, res) => {
    res.send('root');
  });
  router.get('/orders', (_req, res) => {
    res.send('list');
  });
  router.post('/orders/:id', (_req, res) => {
    res.send('update');
  });

  const app = express();
  if (where === 'app') app.use(tag);
  app.use('/api', router);
  return app;
}

describe.each(['app', 'router'] as const)('matcher mounted on the %s', (where) => {
  const app = appWithMatcherIn(where);

  it.each([
    ['GET', '/api/orders', 'api-orders-get'],
    ['GET', '/api/orders?page=2&sort=desc', 'api-orders-get'],
    ['GET', '/API/Orders/', 'api-orders-get'],
    ['HEAD', '/api/orders', 'api-orders-get'],
    ['POST', '/api/orders/7', 'api-orders-any'],
    ['GET', '/api', 'api-root'],
    ['GET', '/api/', 'api-root'],
  ] as const)('%s %s → %s', async (method, path, expected) => {
    const verb = ({ GET: 'get', HEAD: 'head', POST: 'post' } as const)[method];
    const res = await request(app)[verb](path);
    expect(res.status).toBe(200);
    expect(res.headers['x-rule']).toBe(expected);
  });
});
