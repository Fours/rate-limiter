import type { Server } from 'node:http';
import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenBucket } from '../src/algorithms/token-bucket.js';
import { rateLimit, type RateLimitOptions } from '../src/middleware.js';
import { InvalidRuleError } from '../src/rules.js';
import type { Algorithm, Rule } from '../src/types.js';
import { FakeClock } from './helpers/fake-clock.js';

const rule: Rule = { id: 'global', limit: 2, windowMs: 10_000 };

interface Harness {
  app: Express;
  /** How many times the route handler ran. */
  handled: () => number;
  /** Errors that reached the app's error handler. */
  errors: unknown[];
  clock: FakeClock;
}

/** A real Express app with the limiter on every route, and a FakeClock-driven bucket by default. */
function harness(opts: Partial<RateLimitOptions> = {}, setup?: (app: Express) => void): Harness {
  const clock = new FakeClock();
  const algorithm = opts.algorithm ?? createTokenBucket({ clock });
  const errors: unknown[] = [];
  let count = 0;

  const app = express();
  setup?.(app);
  app.use(rateLimit({ rules: [rule], ...opts, algorithm }));
  app.all('/{*rest}', (_req, res) => {
    count++;
    res.send('ok');
  });
  // Express only treats a function as an error handler when it declares all four arguments.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    errors.push(err);
    res.status(500).send('error');
  };
  app.use(onError);
  return { app, handled: () => count, errors, clock };
}

const limitHeaders = ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'retry-after'];

describe('rateLimit middleware', () => {
  describe('headers and responses', () => {
    it('sets the RateLimit headers on an allowed response, and no Retry-After', async () => {
      const { app } = harness();
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      // One of two tokens used: half a window (5 s) until full.
      expect(res.headers).toMatchObject({
        'ratelimit-limit': '2',
        'ratelimit-remaining': '1',
        'ratelimit-reset': '5',
      });
      expect(res.headers).not.toHaveProperty('retry-after');
    });

    it('denies with 429, the JSON body, the headers and Retry-After once the limit is used', async () => {
      const { app } = harness();
      await request(app).get('/');
      await request(app).get('/');
      const res = await request(app).get('/');

      expect(res.status).toBe(429);
      expect(res.type).toBe('application/json');
      expect(res.body).toStrictEqual({ error: 'rate_limited' });
      // Empty bucket: one token takes windowMs / limit = 5 s.
      expect(res.headers).toMatchObject({
        'ratelimit-limit': '2',
        'ratelimit-remaining': '0',
        'ratelimit-reset': '5',
        'retry-after': '5',
      });
    });

    it('allows exactly one more request after waiting Retry-After', async () => {
      const { app, clock } = harness();
      await request(app).get('/');
      await request(app).get('/');
      const denied = await request(app).get('/');

      clock.advance(Number(denied.headers['retry-after']) * 1_000);
      expect((await request(app).get('/')).status).toBe(200);
      expect((await request(app).get('/')).status).toBe(429);
    });

    it('does not run the route handler for a denied request', async () => {
      const { app, handled } = harness();
      for (let i = 0; i < 5; i++) await request(app).get('/');
      expect(handled()).toBe(rule.limit);
    });
  });

  describe('requests no rule matches', () => {
    it.each([
      ['an empty rule list', [] as Rule[]],
      ['a rule for another path', [{ ...rule, path: '/orders' }]],
    ])('pass through with no headers, given %s', async (_label, rules) => {
      const { app, handled } = harness({ rules });
      for (let i = 0; i < rule.limit + 2; i++) {
        const res = await request(app).get('/other');
        expect(res.status).toBe(200);
        for (const name of limitHeaders) expect(res.headers).not.toHaveProperty(name);
      }
      expect(handled()).toBe(rule.limit + 2);
    });
  });

  describe('identity', () => {
    it('uses a custom identify, so each client gets its own bucket', async () => {
      const { app } = harness({ identify: (req) => req.get('x-client') ?? 'none' });
      for (let i = 0; i < rule.limit; i++) await request(app).get('/').set('x-client', 'a');
      expect((await request(app).get('/').set('x-client', 'a')).status).toBe(429);
      expect((await request(app).get('/').set('x-client', 'b')).status).toBe(200);
    });

    it('uses a custom tier to pick the rule', async () => {
      const rules: Rule[] = [
        { id: 'free', limit: 1, windowMs: 10_000, tier: 'free' },
        { id: 'any', limit: 5, windowMs: 10_000 },
      ];
      const { app } = harness({ rules, tier: (req) => req.get('x-tier') });
      const free = await request(app).get('/').set('x-tier', 'free');
      const pro = await request(app).get('/').set('x-tier', 'pro');
      expect(free.headers['ratelimit-limit']).toBe('1');
      expect(pro.headers['ratelimit-limit']).toBe('5');
    });

    it.each([
      [true, 200],
      [false, 429],
    ])(
      'with trust proxy %s, a new X-Forwarded-For gets status %i',
      async (trustProxy, expected) => {
        const { app } = harness({}, (a) => a.set('trust proxy', trustProxy));
        const from = (ip: string) => request(app).get('/').set('X-Forwarded-For', ip);
        for (let i = 0; i < rule.limit; i++) await from('203.0.113.1');
        expect((await from('203.0.113.1')).status).toBe(429);
        expect((await from('203.0.113.2')).status).toBe(expected);
      },
    );
  });

  describe('errors', () => {
    it('with fallback: false, passes an algorithm failure to next(err) and skips the handler', async () => {
      const failure = new Error('store down');
      const algorithm: Algorithm = { check: () => Promise.reject(failure) };
      const { app, errors, handled } = harness({ algorithm, fallback: false });
      const res = await request(app).get('/');
      expect(res.status).toBe(500);
      expect(errors).toStrictEqual([failure]);
      expect(handled()).toBe(0);
      for (const name of limitHeaders) expect(res.headers).not.toHaveProperty(name);
    });

    it.each([
      [
        'identify',
        {
          identify: () => {
            throw new Error('bad identify');
          },
        },
      ],
      [
        'tier',
        {
          tier: () => {
            throw new Error('bad tier');
          },
        },
      ],
    ] as const)('passes a throwing %s to next(err)', async (_label, opts) => {
      const { app, errors, handled } = harness(opts);
      expect((await request(app).get('/')).status).toBe(500);
      expect(errors).toHaveLength(1);
      expect(handled()).toBe(0);
    });
  });

  it('allows exactly 10 of 50 concurrent requests against limit: 10', async () => {
    const { app, handled } = harness({ rules: [{ id: 'burst', limit: 10, windowMs: 60_000 }] });
    // One shared server, so the requests really overlap instead of each starting its own.
    const server: Server = app.listen(0);
    try {
      const statuses = (
        await Promise.all(Array.from({ length: 50 }, () => request(server).get('/')))
      ).map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(40);
      expect(handled()).toBe(10);
    } finally {
      server.close();
    }
  });

  it('limits the full path when mounted inside a router', async () => {
    const rules: Rule[] = [{ id: 'orders', limit: 1, windowMs: 10_000, path: '/api/orders' }];
    const router = express.Router();
    router.use(rateLimit({ rules, algorithm: createTokenBucket({ clock: new FakeClock() }) }));
    router.get('/orders', (_req, res) => res.send('ok'));
    const app = express().use('/api', router);

    expect((await request(app).get('/api/orders')).status).toBe(200);
    expect((await request(app).get('/api/orders')).status).toBe(429);
  });

  describe('startup checks', () => {
    it('throws InvalidRuleError for invalid rules', () => {
      expect(() => rateLimit({ rules: [{ id: '', limit: 1, windowMs: 1 }] })).toThrow(
        InvalidRuleError,
      );
    });

    it.each([
      ['identify', { identify: 'ip' }],
      ['tier', { tier: 42 }],
      ['algorithm', { algorithm: {} }],
      ['algorithm', { algorithm: null }],
    ])('throws a TypeError when %s is not usable', (name, bad) => {
      const opts = { rules: [rule], ...bad } as unknown as RateLimitOptions;
      expect(() => rateLimit(opts)).toThrow(new RegExp(`rateLimit: ${name}`));
    });
  });

  describe('close()', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops the sweep timer of the bucket it created', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const limiter = rateLimit({ rules: [rule] });
      expect(vi.getTimerCount()).toBe(1);
      limiter.close();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves an algorithm passed in alone', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const bucket = createTokenBucket({ clock: new FakeClock() });
      const close = vi.spyOn(bucket, 'close');
      rateLimit({ rules: [rule], algorithm: bucket }).close();
      expect(close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      bucket.close();
    });
  });
});
