import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rateLimit, type RateLimitMiddleware, type RateLimitOptions } from '../src/middleware.js';
import { RateLimitTimeoutError } from '../src/timeout.js';
import type { Algorithm, Decision, Rule } from '../src/types.js';
import { untilTimerPending } from './helpers/timers.js';

// The fallback runs on the system clock. An hour-long window refills one token every 10 minutes,
// so no test here can see a refill.
const rule: Rule = { id: 'global', limit: 6, windowMs: 3_600_000 };

const allowed: Decision = { allowed: true, remaining: 5, resetMs: 1000 };
const never: Algorithm = { check: () => new Promise<Decision>(() => undefined) };
const failure = new Error('store down');
const rejecting: Algorithm = { check: () => Promise.reject(failure) };
const throwing: Algorithm = {
  check: () => {
    throw failure;
  },
};

interface Harness {
  app: Express;
  limiter: RateLimitMiddleware;
  errors: unknown[];
}

const limiters: RateLimitMiddleware[] = [];
afterEach(() => {
  for (const limiter of limiters.splice(0)) limiter.close();
  vi.useRealTimers();
});

function harness(opts: Partial<RateLimitOptions>): Harness {
  const errors: unknown[] = [];
  const limiter = rateLimit({ rules: [rule], ...opts });
  limiters.push(limiter);
  const app = express();
  app.use(limiter);
  app.get('/', (_req, res) => res.send('ok'));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    errors.push(err);
    res.status(500).send('error');
  };
  app.use(onError);
  return { app, limiter, errors };
}

/** Sends a request whose check hangs, and moves fake time on once its timeout is pending. */
async function getAfter(app: Express, ms: number) {
  const response = request(app)
    .get('/')
    .then((res) => res);
  await untilTimerPending();
  await vi.advanceTimersByTimeAsync(ms);
  return response;
}

describe('timeout and fallback', () => {
  it('answers from the fallback once a hanging check reaches timeoutMs (default 50)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { app, errors } = harness({ algorithm: never });
    const res = await getAfter(app, 50);
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('6');
    expect(res.headers['ratelimit-remaining']).toBe('5');
    expect(errors).toStrictEqual([]);
  });

  it('waits the whole of a custom timeoutMs, and no longer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { app } = harness({ algorithm: never, timeoutMs: 10 });
    let done = false;
    const response = request(app)
      .get('/')
      .then((res) => {
        done = true;
        return res;
      });
    await untilTimerPending();
    await vi.advanceTimersByTimeAsync(9);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await response).status).toBe(200);
  });

  it.each([
    ['rejects', rejecting],
    ['throws synchronously', throwing],
  ])('falls back at once when the check %s', async (_name, algorithm) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { app, errors } = harness({ algorithm });
    // No fake time passes, so an answer means it didn't wait for the timeout.
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(errors).toStrictEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind when the check answers in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { app } = harness({ algorithm: { check: () => Promise.resolve(allowed) } });
    expect((await request(app).get('/')).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows ceil(limit / instances) per window, and the headers report that limit', async () => {
    const { app } = harness({ algorithm: rejecting, fallback: { instances: 4 } });
    // ceil(6 / 4) = 2
    const first = await request(app).get('/');
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect((await request(app).get('/')).status).toBe(200);

    const denied = await request(app).get('/');
    expect(denied.status).toBe(429);
    expect(denied.body).toStrictEqual({ error: 'rate_limited' });
    expect(denied.headers['ratelimit-limit']).toBe('2');
    expect(denied.headers['retry-after']).toBeDefined();
  });

  it('shares a burst between instances like the limit', async () => {
    // limit 6, burst 9 over 3 instances: each allows ceil(9 / 3) = 3 at once, at 2 an hour.
    const algorithm: Algorithm = { supportsBurst: true, check: () => Promise.reject(failure) };
    const { app } = harness({
      rules: [{ ...rule, burst: 9 }],
      algorithm,
      fallback: { instances: 3 },
    });
    const first = await request(app).get('/');
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('2');
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(429);
  });

  it('allows the full limit with the default of one instance', async () => {
    const { app } = harness({ algorithm: rejecting });
    const statuses = [];
    for (let i = 0; i < rule.limit + 1; i++) statuses.push((await request(app).get('/')).status);
    expect(statuses).toStrictEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it('goes back to the primary as soon as it answers again', async () => {
    let up = false;
    const algorithm: Algorithm = {
      check: () => (up ? Promise.resolve(allowed) : Promise.reject(failure)),
    };
    const { app } = harness({ algorithm, fallback: { instances: 3 } });
    expect((await request(app).get('/')).headers['ratelimit-limit']).toBe('2');
    up = true;
    expect((await request(app).get('/')).headers['ratelimit-remaining']).toBe('5');
  });

  it('creates the fallback on the first failure, and close() stops it', async () => {
    // The fallback bucket's sweep runs on setInterval, so the timer count shows whether it exists.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app, limiter } = harness({ algorithm: rejecting });
    expect(vi.getTimerCount()).toBe(0);
    await request(app).get('/');
    expect(vi.getTimerCount()).toBe(1);
    limiter.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('creates no fallback while the primary keeps answering', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app } = harness({ algorithm: { check: () => Promise.resolve(allowed) } });
    await request(app).get('/');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fallback: false', () => {
  it('sends a failed check to the error handler, as before milestone 4', async () => {
    const { app, errors } = harness({ algorithm: rejecting, fallback: false });
    expect((await request(app).get('/')).status).toBe(500);
    expect(errors).toStrictEqual([failure]);
  });

  it('sends a RateLimitTimeoutError to the error handler when the check times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { app, errors } = harness({ algorithm: never, fallback: false, timeoutMs: 20 });
    const res = await getAfter(app, 20);
    expect(res.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RateLimitTimeoutError);
    expect(errors[0]).toMatchObject({ timeoutMs: 20 });
    for (const name of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
      expect(res.headers).not.toHaveProperty(name);
    }
  });
});

describe('errors that are not outages', () => {
  const bug = new Error('caller bug');
  const thrower = () => {
    throw bug;
  };

  it.each([
    ['identify', { identify: thrower }],
    ['tier', { tier: thrower }],
  ])('an error in %s goes to next(err), even with the fallback on', async (_name, opts) => {
    const { app, errors } = harness({ ...opts, algorithm: rejecting, fallback: { instances: 3 } });
    expect((await request(app).get('/')).status).toBe(500);
    expect(errors).toStrictEqual([bug]);
  });

  it('an error in rule matching goes to next(err), even with the fallback on', async () => {
    // Matching reads req.method and req.path. A getter that throws stands in for a matching bug.
    const errors: unknown[] = [];
    const limiter = rateLimit({ rules: [rule], algorithm: rejecting });
    limiters.push(limiter);
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'path', { get: thrower });
      next();
    });
    app.use(limiter);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
      errors.push(err);
      res.status(500).send('error');
    };
    app.use(onError);
    expect((await request(app).get('/')).status).toBe(500);
    expect(errors).toStrictEqual([bug]);
  });
});

describe('options', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '50', null])(
    'rejects timeoutMs: %s at startup',
    (timeoutMs) => {
      expect(() => rateLimit({ rules: [rule], timeoutMs: timeoutMs as number })).toThrow(
        /timeoutMs must be a positive integer/,
      );
    },
  );

  it.each([null, true, 3, 'yes'])('rejects fallback: %s at startup', (fallback) => {
    expect(() => rateLimit({ rules: [rule], fallback: fallback as false })).toThrow(
      'rateLimit: fallback must be { instances } or false',
    );
  });

  it.each([0, -2, 2.5, Number.NaN, '3'])(
    'rejects fallback.instances: %s at startup',
    (instances) => {
      expect(() =>
        rateLimit({ rules: [rule], fallback: { instances: instances as number } }),
      ).toThrow(/fallback.instances must be a positive integer/);
    },
  );

  it('says what it got, quoting strings', () => {
    expect(() => rateLimit({ rules: [rule], timeoutMs: '50' as unknown as number })).toThrow(
      'rateLimit: timeoutMs must be a positive integer, got "50"',
    );
    expect(() => rateLimit({ rules: [rule], timeoutMs: {} as unknown as number })).toThrow(
      'got object',
    );
  });

  it('accepts an empty fallback object as one instance', () => {
    limiters.push(rateLimit({ rules: [rule], fallback: {} }));
  });
});
