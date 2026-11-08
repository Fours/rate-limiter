import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createTokenBucket } from '../src/algorithms/token-bucket.js';
import { rateLimit } from '../src/middleware.js';
import { createMatcher } from '../src/rules.js';
import type { Rule } from '../src/types.js';
import { FakeClock } from './helpers/fake-clock.js';

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

// The attack from the 1.0 security review: handlers that decode the path serve the same resource
// for spellings a raw comparison wouldn't match (decision 0027). Each spelling must be limited.
describe('spellings a decoding handler serves the same (0027)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-static-'));
  mkdirSync(join(dir, 'downloads'));
  writeFileSync(join(dir, 'downloads', 'big.zip'), 'ZIP');
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function staticApp() {
    const limiter = rateLimit({
      rules: [{ id: 'dl', limit: 1, windowMs: 60_000, path: '/downloads/*' }],
      algorithm: createTokenBucket({ clock: new FakeClock() }),
    });
    const app = express();
    app.use(limiter);
    app.use(express.static(dir));
    return app;
  }

  it.each([
    '/%64ownloads/big.zip',
    '/downloads%2fbig.zip',
    '//downloads/big.zip',
    '/./downloads/big.zip',
    '/x/../downloads/big.zip',
    '/%2e/downloads/big.zip',
    '/x/%2e%2e/downloads/big.zip',
  ])('limits %s under express.static once the plain path is used up', async (spelling) => {
    const app = staticApp();
    const first = await request(app).get('/downloads/big.zip');
    expect(first.status).toBe(200);
    const res = await request(app).get(spelling);
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit-limit']).toBe('1');
  });

  it('serves the file for each spelling, so the test above is a real bypass when unlimited', async () => {
    const app = express();
    app.use(express.static(dir));
    for (const spelling of [
      '/%64ownloads/big.zip',
      '//downloads/big.zip',
      '/x/../downloads/big.zip',
    ]) {
      expect((await request(app).get(spelling)).text).toBe('ZIP');
    }
  });

  it('limits an encoded :param the router decodes', async () => {
    const limiter = rateLimit({
      rules: [{ id: 'acme', limit: 1, windowMs: 60_000, path: '/t/acme/*' }],
      algorithm: createTokenBucket({ clock: new FakeClock() }),
    });
    const router = express.Router({ mergeParams: true });
    router.get('/report', (req, res) => {
      res.send(`report for ${String((req.params as { tenant?: string }).tenant)}`);
    });
    const app = express();
    app.use(limiter);
    app.use('/t/:tenant', router);
    expect((await request(app).get('/t/acme/report')).status).toBe(200);
    const res = await request(app).get('/t/%61cme/report');
    expect(res.status).toBe(429);
  });
});

// Express's routing and mounts keep ".." as an ordinary segment, unlike express.static, so a
// request can reach /admin handlers while resolving to a path outside /admin/* (decision 0030).
describe('dot-dot paths Express routes without resolving (0030)', () => {
  function adminApp() {
    const app = express();
    app.use(
      rateLimit({
        rules: [{ id: 'admin', limit: 1, windowMs: 60_000, path: '/admin/*' }],
        algorithm: createTokenBucket({ clock: new FakeClock() }),
      }),
    );
    app.get('/admin/:name', (req, res) => {
      res.send(`admin ${req.params.name}`);
    });
    app.use('/admin', (_req, res) => {
      res.send('admin mount');
    });
    return app;
  }

  const spellings = ['/admin/..', '/admin/%2E%2E', '/admin/..%2Fx', '/admin/x/../../y'];

  it.each(spellings)('limits %s once the admin limit is used up', async (spelling) => {
    const app = adminApp();
    expect((await request(app).get('/admin/first')).status).toBe(200);
    const res = await request(app).get(spelling);
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit-limit']).toBe('1');
  });

  it('reaches an admin handler for each spelling, so the test above is a real bypass when unlimited', async () => {
    const app = express();
    app.get('/admin/:name', (req, res) => {
      res.send(`admin ${req.params.name}`);
    });
    app.use('/admin', (_req, res) => {
      res.send('admin mount');
    });
    for (const spelling of spellings) {
      expect((await request(app).get(spelling)).text).toMatch(/^admin /);
    }
  });
});
