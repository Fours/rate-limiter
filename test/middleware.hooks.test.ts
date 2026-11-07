import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenBucket } from '../src/algorithms/token-bucket.js';
import type { DecisionEvent, FallbackEvent, RateLimitHooks } from '../src/hooks.js';
import { rateLimit, type RateLimitMiddleware, type RateLimitOptions } from '../src/middleware.js';
import type { Algorithm, Decision, Rule } from '../src/types.js';
import { FakeClock } from './helpers/fake-clock.js';
import { untilTimerPending } from './helpers/timers.js';

// Only GET /limited matches, so other paths show what happens to unlimited requests.
const rule: Rule = { id: 'api', limit: 2, windowMs: 3_600_000, path: '/limited' };

const failure = new Error('store down');
const rejecting: Algorithm = { check: () => Promise.reject(failure) };
const never: Algorithm = { check: () => new Promise<Decision>(() => undefined) };

interface Recorded {
  calls: string[];
  decisions: DecisionEvent[];
  fallbacks: FallbackEvent[];
}

/** Hooks that record what they're given, in the order they're called. */
function recording(): Recorded & { hooks: RateLimitHooks } {
  const r: Recorded = { calls: [], decisions: [], fallbacks: [] };
  return {
    ...r,
    hooks: {
      onDecision: (event) => {
        r.calls.push('onDecision');
        r.decisions.push(event);
      },
      onFallback: (event) => {
        r.calls.push('onFallback');
        r.fallbacks.push(event);
      },
    },
  };
}

const limiters: RateLimitMiddleware[] = [];
afterEach(() => {
  for (const limiter of limiters.splice(0)) limiter.close();
  vi.useRealTimers();
});

function harness(opts: Partial<RateLimitOptions>): { app: Express; errors: unknown[] } {
  const errors: unknown[] = [];
  const limiter = rateLimit({
    rules: [rule],
    algorithm: createTokenBucket({ clock: new FakeClock() }),
    ...opts,
  });
  limiters.push(limiter);
  const app = express();
  app.use(limiter);
  app.get('/{*rest}', (_req, res) => res.send('ok'));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    errors.push(err);
    res.status(500).send('error');
  };
  app.use(onError);
  return { app, errors };
}

describe('onDecision', () => {
  it('gets every decision from the primary, allowed and denied', async () => {
    const r = recording();
    const { app } = harness({ hooks: r.hooks });
    for (let i = 0; i < 3; i++) await request(app).get('/limited').set('x-forwarded-for', 'x');

    expect(r.decisions.map((e) => [e.decision.allowed, e.decision.remaining])).toStrictEqual([
      [true, 1],
      [true, 0],
      [false, 0],
    ]);
    const [first] = r.decisions;
    expect(first?.source).toBe('primary');
    expect(first?.rule).toBe(rule);
    expect(first?.limit).toBe(2);
    expect(first?.key).toMatch(/^rl:api:/);
    expect(first?.req.path).toBe('/limited');
    expect(r.fallbacks).toStrictEqual([]);
  });

  it('gets fallback decisions, with the configured rule and the scaled limit', async () => {
    const r = recording();
    const { app } = harness({
      algorithm: rejecting,
      fallback: { instances: 2 },
      hooks: r.hooks,
      rules: [{ ...rule, limit: 4 }],
    });
    for (let i = 0; i < 3; i++) await request(app).get('/limited');

    expect(r.decisions.map((e) => [e.source, e.decision.allowed])).toStrictEqual([
      ['fallback', true],
      ['fallback', true],
      ['fallback', false],
    ]);
    expect(r.decisions[0]?.rule.limit).toBe(4);
    expect(r.decisions[0]?.limit).toBe(2);
  });

  it('gives a non-negative, finite durationMs', async () => {
    const r = recording();
    const { app } = harness({ hooks: r.hooks });
    await request(app).get('/limited');
    const duration = r.decisions[0]?.durationMs;
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);
  });
});

describe('onFallback', () => {
  it('gets reason "error" and the error, before onDecision', async () => {
    const r = recording();
    const { app } = harness({ algorithm: rejecting, hooks: r.hooks });
    await request(app).get('/limited');

    expect(r.calls).toStrictEqual(['onFallback', 'onDecision']);
    expect(r.fallbacks).toHaveLength(1);
    expect(r.fallbacks[0]).toMatchObject({ rule, reason: 'error', error: failure });
    expect(r.fallbacks[0]?.key).toBe(r.decisions[0]?.key);
  });

  it('gets reason "timeout", with no error, when the check hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = recording();
    const { app } = harness({ algorithm: never, hooks: r.hooks });
    const pending = request(app)
      .get('/limited')
      .then((res) => res);
    await untilTimerPending();
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending).status).toBe(200);

    expect(r.calls).toStrictEqual(['onFallback', 'onDecision']);
    expect(r.fallbacks[0]?.reason).toBe('timeout');
    expect(r.fallbacks[0]).not.toHaveProperty('error');
  });

  it('is not called with fallback: false, where nothing falls back', async () => {
    const r = recording();
    const { app } = harness({ algorithm: rejecting, fallback: false, hooks: r.hooks });
    expect((await request(app).get('/limited')).status).toBe(500);
    expect(r.calls).toStrictEqual([]);
  });
});

describe('requests no rule matches', () => {
  it('call neither hook', async () => {
    const r = recording();
    const { app } = harness({ algorithm: rejecting, hooks: r.hooks });
    expect((await request(app).get('/other')).status).toBe(200);
    expect(r.calls).toStrictEqual([]);
  });
});

describe('hooks that fail', () => {
  /** Status, limit headers and body: what a client sees. */
  async function seen(app: Express) {
    const res = await request(app).get('/limited');
    return [res.status, res.headers['ratelimit-remaining'], res.headers['retry-after'], res.text];
  }

  const throwing = () => {
    throw new Error('hook bug');
  };
  const rejectingHook = () => Promise.reject(new Error('async hook bug'));

  it.each([
    ['throw', throwing],
    ['return a rejected promise', rejectingHook],
  ])(
    'that %s change nothing a client sees, and leave no unhandledRejection',
    async (_name, hook) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        // The same traffic with and without the bad hooks, through primary and fallback alike.
        for (const algorithm of [undefined, rejecting]) {
          const plain = harness(algorithm === undefined ? {} : { algorithm });
          const bad = harness({
            ...(algorithm === undefined ? {} : { algorithm }),
            hooks: { onDecision: hook, onFallback: hook },
          });
          for (let i = 0; i < 3; i++)
            expect(await seen(bad.app)).toStrictEqual(await seen(plain.app));
          expect(bad.errors).toStrictEqual([]);
        }
        // unhandledRejection fires after the microtask queue drains, on a later macrotask.
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toStrictEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );
});

describe('raw API keys', () => {
  it("appear in none of the limiter's own fields, only in the request itself", async () => {
    const apiKey = 'sk_live_raw_secret_123';
    const r = recording();
    const { app } = harness({ algorithm: rejecting, hooks: r.hooks });
    await request(app).get('/limited').set('x-api-key', apiKey);

    expect(r.decisions).toHaveLength(1);
    expect(r.fallbacks).toHaveLength(1);
    for (const { req, ...fields } of [...r.decisions, ...r.fallbacks]) {
      // The error is an Error, which JSON drops, so its message is checked on its own.
      expect(JSON.stringify(fields)).not.toContain(apiKey);
      if ('error' in fields) expect(String(fields.error)).not.toContain(apiKey);
      expect(req.headers['x-api-key']).toBe(apiKey);
    }
    expect(r.decisions[0]?.key).toMatch(/^rl:api:key_[0-9a-f]{16}$/);
  });
});

describe('one hook alone', () => {
  it('works without the other, on the fallback path that calls both', async () => {
    const decisions: DecisionEvent[] = [];
    const fallbacks: FallbackEvent[] = [];
    const onlyDecision = harness({
      algorithm: rejecting,
      hooks: { onDecision: (e) => void decisions.push(e) },
    });
    const onlyFallback = harness({
      algorithm: rejecting,
      hooks: { onFallback: (e) => void fallbacks.push(e) },
    });
    expect((await request(onlyDecision.app).get('/limited')).status).toBe(200);
    expect((await request(onlyFallback.app).get('/limited')).status).toBe(200);
    expect([decisions.length, fallbacks.length]).toStrictEqual([1, 1]);
  });
});

describe('options', () => {
  it.each([null, 'onDecision', () => undefined])('rejects hooks: %s at startup', (hooks) => {
    expect(() => rateLimit({ rules: [rule], hooks: hooks as RateLimitHooks })).toThrow(
      'rateLimit: hooks must be an object of functions',
    );
  });

  it.each(['onDecision', 'onFallback'])('rejects a %s that is not a function', (name) => {
    expect(() => rateLimit({ rules: [rule], hooks: { [name]: 'log' } })).toThrow(
      `rateLimit: hooks.${name} must be a function`,
    );
  });

  it('accepts an empty hooks object, and either hook alone', () => {
    limiters.push(rateLimit({ rules: [rule], hooks: {} }));
    limiters.push(rateLimit({ rules: [rule], hooks: { onDecision: () => undefined } }));
    limiters.push(rateLimit({ rules: [rule], hooks: { onFallback: () => undefined } }));
  });
});
