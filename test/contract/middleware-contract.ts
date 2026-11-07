import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rateLimit, type RateLimitOptions } from '../../src/middleware.js';
import type { Algorithm, Decision, Rule } from '../../src/types.js';
import type { AlgorithmTraits, AlgorithmUnderTest } from './algorithm-contract.js';

/**
 * The milestone 1 middleware behaviours, written so any algorithm can run them (decision 0001):
 * instead of the token bucket's exact numbers, headers are checked against the decision the
 * algorithm itself returned, and counts against the algorithm's burst. test/middleware.test.ts
 * keeps the exact-number versions for the in-memory bucket.
 */
export function describeMiddleware(
  name: string,
  setup: () => AlgorithmUnderTest | Promise<AlgorithmUnderTest>,
  traits: Pick<AlgorithmTraits, 'burst'>,
): void {
  describe(`${name}: middleware suite`, () => {
    let t: AlgorithmUnderTest;
    beforeEach(async () => {
      t = await setup();
    });
    afterEach(async () => {
      await t.close?.();
    });

    // 60 s or more, because Redis keys expire in real time (see the behaviour suite).
    const freshRule = (overrides: Partial<Omit<Rule, 'id'>> = {}): Rule => ({
      id: `mw:${randomUUID()}`,
      limit: 2,
      windowMs: 60_000,
      ...overrides,
    });

    interface Harness {
      app: Express;
      handled: () => number;
      errors: unknown[];
      /** Every decision the algorithm returned, in order. */
      decisions: Decision[];
    }

    function harness(
      opts: Partial<RateLimitOptions> & { rules: Rule[] },
      configure?: (app: Express) => void,
    ): Harness {
      const decisions: Decision[] = [];
      const inner = opts.algorithm ?? t.algorithm;
      const recording: Algorithm = {
        check: async (key, rule) => {
          const decision = await inner.check(key, rule);
          decisions.push(decision);
          return decision;
        },
      };
      const errors: unknown[] = [];
      let count = 0;
      const app = express();
      configure?.(app);
      app.use(rateLimit({ ...opts, algorithm: recording }));
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
      return { app, handled: () => count, errors, decisions };
    }

    const seconds = (ms: number) => String(Math.ceil(ms / 1000));
    const limitHeaders = [
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'retry-after',
    ];

    it("sets headers from the algorithm's own decision when allowed, with no Retry-After", async () => {
      const rule = freshRule();
      const h = harness({ rules: [rule] });
      const res = await request(h.app).get('/');
      const decision = h.decisions[0];
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject({
        'ratelimit-limit': String(rule.limit),
        'ratelimit-remaining': String(decision?.remaining),
        'ratelimit-reset': seconds(decision?.resetMs ?? -1),
      });
      expect(res.headers).not.toHaveProperty('retry-after');
    });

    it('denies past its burst with 429, the JSON body, matching headers and Retry-After', async () => {
      const rule = freshRule();
      const h = harness({ rules: [rule] });
      for (let i = 0; i < traits.burst(rule); i++) {
        expect((await request(h.app).get('/')).status).toBe(200);
      }
      const res = await request(h.app).get('/');
      const denied = h.decisions.at(-1);
      expect(res.status).toBe(429);
      expect(res.type).toBe('application/json');
      expect(res.body).toStrictEqual({ error: 'rate_limited' });
      expect(res.headers).toMatchObject({
        'ratelimit-limit': String(rule.limit),
        'ratelimit-remaining': '0',
        'ratelimit-reset': seconds(denied?.resetMs ?? -1),
        'retry-after': String(Math.max(1, Math.ceil((denied?.resetMs ?? -1) / 1000))),
      });
    });

    it('allows the next request once Retry-After has passed', async () => {
      const rule = freshRule();
      const h = harness({ rules: [rule] });
      let res = await request(h.app).get('/');
      while (res.status === 200) res = await request(h.app).get('/');
      t.clock.advance(Number(res.headers['retry-after']) * 1_000);
      expect((await request(h.app).get('/')).status).toBe(200);
    });

    it('runs the route handler only for allowed requests', async () => {
      const rule = freshRule();
      const h = harness({ rules: [rule] });
      for (let i = 0; i < 5; i++) await request(h.app).get('/');
      expect(h.handled()).toBe(traits.burst(rule));
    });

    it('passes requests no rule matches through with no headers', async () => {
      const rule = freshRule({ path: '/orders' });
      const h = harness({ rules: [rule] });
      for (let i = 0; i < 5; i++) {
        const res = await request(h.app).get('/other');
        expect(res.status).toBe(200);
        for (const header of limitHeaders) expect(res.headers).not.toHaveProperty(header);
      }
    });

    it('uses a custom identify, so each client is limited separately', async () => {
      const rule = freshRule();
      const h = harness({ rules: [rule], identify: (req) => req.get('x-client') ?? 'none' });
      const as = (client: string) => request(h.app).get('/').set('x-client', client);
      for (let i = 0; i < traits.burst(rule); i++) await as('a');
      expect((await as('a')).status).toBe(429);
      expect((await as('b')).status).toBe(200);
    });

    it('uses a custom tier to pick the rule', async () => {
      const free = freshRule({ limit: 1, tier: 'free' });
      const any = freshRule({ limit: 5 });
      const h = harness({ rules: [free, any], tier: (req) => req.get('x-tier') });
      expect((await request(h.app).get('/').set('x-tier', 'free')).headers['ratelimit-limit']).toBe(
        '1',
      );
      expect((await request(h.app).get('/').set('x-tier', 'pro')).headers['ratelimit-limit']).toBe(
        '5',
      );
    });

    it.each([
      [true, 200],
      [false, 429],
    ])(
      'with trust proxy %s, a new X-Forwarded-For gets status %i',
      async (trustProxy, expected) => {
        const rule = freshRule();
        const h = harness({ rules: [rule] }, (app) => app.set('trust proxy', trustProxy));
        const from = (ip: string) => request(h.app).get('/').set('X-Forwarded-For', ip);
        for (let i = 0; i < traits.burst(rule); i++) await from('203.0.113.1');
        expect((await from('203.0.113.1')).status).toBe(429);
        expect((await from('203.0.113.2')).status).toBe(expected);
      },
    );

    it('with fallback: false, passes a failed check to next(err) and skips the handler', async () => {
      const failure = new Error('store down');
      // The real check runs, then fails, so the error path is taken with this algorithm's state.
      const failing: Algorithm = {
        check: (key, rule) =>
          t.algorithm.check(key, rule).then(() => {
            throw failure;
          }),
      };
      const h = harness({ rules: [freshRule()], algorithm: failing, fallback: false });
      expect((await request(h.app).get('/')).status).toBe(500);
      expect(h.errors).toStrictEqual([failure]);
      expect(h.handled()).toBe(0);
    });

    it('answers a failed check from the fallback, with the limit split over the instances', async () => {
      const rule = freshRule({ limit: 10 });
      // The real check runs first, so this algorithm's state is touched, then the check fails.
      const failing: Algorithm = {
        check: (key, r) =>
          t.algorithm.check(key, r).then(() => {
            throw new Error('store down');
          }),
      };
      const h = harness({ rules: [rule], algorithm: failing, fallback: { instances: 3 } });
      const res = await request(h.app).get('/');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBe('4');
      expect(h.errors).toStrictEqual([]);
      expect(h.handled()).toBe(1);
    });

    it('allows exactly its burst of 50 concurrent requests against limit: 10', async () => {
      const rule = freshRule({ limit: 10 });
      const h = harness({ rules: [rule] });
      const server: Server = h.app.listen(0);
      try {
        const statuses = (
          await Promise.all(Array.from({ length: 50 }, () => request(server).get('/')))
        ).map((res) => res.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(traits.burst(rule));
        expect(statuses.filter((s) => s === 429)).toHaveLength(50 - traits.burst(rule));
      } finally {
        server.close();
      }
    });
  });
}
