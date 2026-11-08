import type { Server } from 'node:http';
import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedisFixedWindow } from '../src/algorithms/redis/fixed-window.js';
import { createRedisLeakyBucket } from '../src/algorithms/redis/leaky-bucket.js';
import { createRedisSlidingWindowCounter } from '../src/algorithms/redis/sliding-window-counter.js';
import { createRedisSlidingWindowLog } from '../src/algorithms/redis/sliding-window-log.js';
import { createRedisTokenBucket } from '../src/algorithms/redis/token-bucket.js';
import { createTokenBucket } from '../src/algorithms/token-bucket.js';
import { rateLimit, type RateLimitOptions } from '../src/middleware.js';
import { parseRules } from '../src/rules-file.js';
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

describe('burst', () => {
  // Never called: these algorithms only need to exist for the startup check.
  const client = {
    evalsha: () => Promise.resolve([1, 0, 0]),
    eval: () => Promise.resolve([1, 0, 0]),
  };
  const bursty: Rule = { id: 'bursty', limit: 10, windowMs: 1_000, burst: 3 };

  it.each([
    ['the fixed window', createRedisFixedWindow({ client })],
    ['the sliding window log', createRedisSlidingWindowLog({ client })],
    ['the sliding window counter', createRedisSlidingWindowCounter({ client })],
    [
      'an algorithm of your own',
      { check: () => Promise.resolve({ allowed: true, remaining: 0, resetMs: 0 }) },
    ],
  ])('refuses a rule with a burst at startup for %s', (_name, algorithm: Algorithm) => {
    expect(() => rateLimit({ rules: [rule, bursty], algorithm })).toThrow(
      new InvalidRuleError(
        'rateLimit: rule "bursty" has a burst, but its algorithm doesn\'t take one. Only the token ' +
          'bucket and the leaky bucket do; remove the burst or change the algorithm.',
      ),
    );
    // Without the burst, the same algorithm is fine.
    expect(() => rateLimit({ rules: [rule], algorithm })).not.toThrow();
  });

  it.each([
    ['the in-memory token bucket', undefined],
    ['the Redis token bucket', createRedisTokenBucket({ client })],
    ['the Redis leaky bucket', createRedisLeakyBucket({ client })],
    [
      'an algorithm of your own that says so',
      {
        supportsBurst: true as const,
        check: () => Promise.resolve({ allowed: true, remaining: 0, resetMs: 0 }),
      },
    ],
  ])('accepts a burst for %s', (_name, algorithm: Algorithm | undefined) => {
    const limiter = rateLimit({
      rules: [bursty],
      ...(algorithm === undefined ? {} : { algorithm }),
    });
    limiter.close();
  });

  it('reports the limit as RateLimit-Limit, and the burst left as RateLimit-Remaining', async () => {
    const { app } = harness({ rules: [bursty] });
    const first = await request(app).get('/');
    expect(first.headers['ratelimit-limit']).toBe('10');
    expect(first.headers['ratelimit-remaining']).toBe('2');
    await request(app).get('/');
    await request(app).get('/');
    const denied = await request(app).get('/');
    expect(denied.status).toBe(429);
    expect(denied.headers['ratelimit-limit']).toBe('10');
    expect(denied.headers['ratelimit-remaining']).toBe('0');
    // One token every 100 ms: Retry-After rounds up to 1 s.
    expect(denied.headers['retry-after']).toBe('1');
  });

  it('can report more remaining than the limit when the burst is larger', async () => {
    const { app } = harness({ rules: [{ ...bursty, limit: 2, burst: 5 }] });
    const res = await request(app).get('/');
    expect(res.headers['ratelimit-limit']).toBe('2');
    expect(res.headers['ratelimit-remaining']).toBe('4');
  });
});

describe('algorithm per rule', () => {
  /** Allows everything, and records which keys and rules it saw. */
  function recording(name: string, seen: string[]): Algorithm & { close: () => void } {
    return {
      check: (key, r) => {
        seen.push(`${name} ${r.id} ${key}`);
        return Promise.resolve({ allowed: true, remaining: 1, resetMs: 1_000 });
      },
      close: vi.fn(),
    };
  }
  const login: Rule = {
    id: 'login',
    limit: 5,
    windowMs: 60_000,
    path: '/login',
    algorithm: 'exact',
  };
  const plain: Rule = { id: 'plain', limit: 5, windowMs: 60_000 };

  function app(opts: Partial<RateLimitOptions>) {
    const limiter = rateLimit({ rules: [login, plain], ...opts });
    const a = express();
    a.use(limiter);
    a.all('/{*rest}', (_req, res) => res.send('ok'));
    return { app: a, limiter };
  }

  it('checks a rule that names an algorithm with it, and one that names none with the default', async () => {
    const seen: string[] = [];
    const { app: a } = app({
      algorithm: recording('default', seen),
      algorithms: { exact: recording('exact', seen), smooth: recording('smooth', seen) },
    });
    await request(a).get('/login').set('x-api-key', 'k1');
    await request(a).get('/other').set('x-api-key', 'k1');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^exact login rl:login:key_/);
    expect(seen[1]).toMatch(/^default plain rl:plain:key_/);
  });

  it('uses the in-memory default for rules that name none, when only algorithms is given', async () => {
    const seen: string[] = [];
    const { app: a, limiter } = app({ algorithms: { exact: recording('exact', seen) } });
    // plain is limited by the built-in token bucket: 5, then 429.
    for (let i = 0; i < 5; i++) expect((await request(a).get('/other')).status).toBe(200);
    expect((await request(a).get('/other')).status).toBe(429);
    expect(seen).toHaveLength(0);
    limiter.close();
  });

  it('throws at startup for a name that the algorithms option lacks', () => {
    const seen: string[] = [];
    expect(() =>
      rateLimit({
        rules: [login],
        algorithms: { smooth: recording('s', seen), log: recording('l', seen) },
      }),
    ).toThrow(
      new InvalidRuleError(
        'rateLimit: rule "login" names algorithm "exact", which isn\'t in the algorithms option. Its names are "smooth", "log".',
      ),
    );
    expect(() => rateLimit({ rules: [login] })).toThrow(
      new InvalidRuleError(
        'rateLimit: rule "login" names algorithm "exact", but no algorithms option was given.',
      ),
    );
  });

  it("doesn't take a name from the object's prototype", () => {
    expect(() =>
      rateLimit({ rules: [{ ...login, algorithm: 'toString' }], algorithms: {} }),
    ).toThrow(InvalidRuleError);
  });

  it('throws at startup for a name in a rules file that the algorithms option lacks', async () => {
    const rules = await parseRules(
      'rules:\n  - { id: login, limit: 5, windowMs: 60000, algorithm: exakt }',
      'yaml',
    );
    expect(() => rateLimit({ rules, algorithms: { exact: recording('e', []) } })).toThrow(
      /rule "login" names algorithm "exakt", which isn't in the algorithms option/,
    );
  });

  it('allows names no rule uses', () => {
    rateLimit({ rules: [plain], algorithms: { unused: recording('u', []) } }).close();
  });

  it.each([
    ['not an object', 'exact', 'rateLimit: algorithms must be an object of algorithms by name'],
    ['an array', [], 'rateLimit: algorithms must be an object of algorithms by name'],
    [
      'a value without check',
      { exact: {} },
      'rateLimit: algorithms.exact must have a check(key, rule) function',
    ],
  ])('rejects algorithms that is %s', (_what, algorithms, message) => {
    expect(() =>
      rateLimit({ rules: [plain], algorithms: algorithms as unknown as Record<string, Algorithm> }),
    ).toThrow(new TypeError(message));
  });

  it('closes only what it created: the default bucket, never named algorithms', () => {
    const exact = recording('exact', []);
    const given = recording('given', []);
    rateLimit({ rules: [login, plain], algorithm: given, algorithms: { exact } }).close();
    expect(exact.close).not.toHaveBeenCalled();
    expect(given.close).not.toHaveBeenCalled();

    // The default it created is stopped: no sweep timer left behind.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const limiter = rateLimit({ rules: [login, plain], algorithms: { exact } });
    expect(vi.getTimerCount()).toBe(1);
    limiter.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(exact.close).not.toHaveBeenCalled();
  });

  it("checks a burst against the rule's own algorithm", () => {
    const window: Algorithm = {
      check: () => Promise.resolve({ allowed: true, remaining: 0, resetMs: 0 }),
    };
    const bucket: Algorithm = { ...window, supportsBurst: true };
    const smooth: Rule = { id: 'smooth', limit: 5, windowMs: 1_000, burst: 2, algorithm: 'bucket' };
    // The default takes no burst, but the rule's own algorithm does.
    expect(() =>
      rateLimit({ rules: [smooth], algorithm: window, algorithms: { bucket } }),
    ).not.toThrow();
    // And the other way round.
    expect(() =>
      rateLimit({
        rules: [{ ...smooth, algorithm: 'window' }],
        algorithm: bucket,
        algorithms: { window },
      }),
    ).toThrow(/rule "smooth" has a burst, but its algorithm doesn't take one/);
  });
});
