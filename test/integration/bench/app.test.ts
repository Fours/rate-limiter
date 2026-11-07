import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ALGORITHMS, createApp, parseMetrics, type BenchApp } from '../../../bench/app/app.ts';
import { buildKey, defaultIdentify } from '../../../src/identify.js';
import type { Rule } from '../../../src/types.js';
import { connectIoredis, redisUrl, uniqueRuleId } from '../helpers/redis.js';

const LIMIT = 3;

let redis: Redis;
const apps: BenchApp[] = [];

beforeAll(async () => {
  redis = await connectIoredis();
});
afterEach(() => {
  for (const bench of apps.splice(0)) bench.close();
});
afterAll(() => {
  redis.disconnect();
});

function workRule(): Rule {
  return { id: uniqueRuleId('bench'), limit: LIMIT, windowMs: 60_000, path: '/work' };
}

function start(algorithm: string, rule = workRule(), instance = 'test-1', metrics = false) {
  const bench = createApp({ algorithm, rules: [rule], instance, redisUrl, metrics });
  apps.push(bench);
  return { app: bench.app, rule };
}

/** A client no other test uses, so its key starts empty. */
const newClient = () => `client-${randomUUID()}`;

function keyFor(rule: Rule, apiKey: string): string {
  return buildKey(rule, defaultIdentify({ headers: { 'x-api-key': apiKey } }));
}

/** Which script wrote a key: every script tags its state with its own name (decision 0016). */
async function tagOf(key: string): Promise<string | null> {
  const type = await redis.type(key);
  if (type === 'hash') return redis.hget(key, 'alg');
  if (type === 'zset') {
    const score = await redis.zscore(key, 'alg:sliding-window-log');
    return score === null ? null : 'sliding-window-log';
  }
  return null;
}

describe('ALGORITHM', () => {
  const redisAlgorithms = ALGORITHMS.filter((name) => name !== 'none');

  it('accepts the five Redis algorithms and none', () => {
    expect(redisAlgorithms).toEqual([
      'token-bucket',
      'leaky-bucket',
      'fixed-window',
      'sliding-window-log',
      'sliding-window-counter',
    ]);
    expect(ALGORITHMS).toContain('none');
  });

  it.each(redisAlgorithms)('%s runs its own script', async (algorithm) => {
    const { app, rule } = start(algorithm);
    const client = newClient();
    const res = await request(app).get('/work').set('x-api-key', client);
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe(String(LIMIT));
    expect(await tagOf(keyFor(rule, client))).toBe(algorithm);
  });

  it('none mounts no limiter and stores nothing', async () => {
    const { app, rule } = start('none');
    const client = newClient();
    for (let i = 0; i < LIMIT * 2; i++) {
      const res = await request(app).get('/work').set('x-api-key', client);
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
    expect(await redis.exists(keyFor(rule, client))).toBe(0);
  });

  it('none needs no Redis', () => {
    expect(() => createApp({ algorithm: 'none', rules: [], instance: 'x' })).not.toThrow();
  });

  it('rejects an unknown algorithm at startup, listing the valid ones', () => {
    expect(() =>
      createApp({ algorithm: 'token-buket', rules: [], instance: 'x', redisUrl }),
    ).toThrow(/Unknown ALGORITHM "token-buket". Use one of: token-bucket, .*, none/);
  });

  it('rejects a Redis algorithm without REDIS_URL at startup', () => {
    expect(() => createApp({ algorithm: 'fixed-window', rules: [], instance: 'x' })).toThrow(
      'ALGORITHM=fixed-window needs REDIS_URL',
    );
  });
});

describe('/healthz', () => {
  // A rule with no path covers every route, /healthz included if it sat behind the limiter.
  // With a /work-only rule this test would pass even then.
  it('is never limited and never uses up a client’s limit, even under a catch-all rule', async () => {
    const everyRoute: Rule = { id: uniqueRuleId('bench'), limit: LIMIT, windowMs: 60_000 };
    const { app } = start('token-bucket', everyRoute);
    const client = newClient();
    for (let i = 0; i < LIMIT * 3; i++) {
      const res = await request(app).get('/healthz').set('x-api-key', client);
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
    const statuses: number[] = [];
    for (let i = 0; i <= LIMIT; i++) {
      statuses.push((await request(app).get('/work').set('x-api-key', client)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('/metrics (METRICS=1)', () => {
  /** One sample's value from the text format, or 0 when the series isn't there yet. */
  function sample(body: string, series: string): number {
    const line = body.split('\n').find((l) => l.startsWith(`${series} `));
    return line === undefined ? 0 : Number(line.slice(series.length + 1));
  }

  it('counts allowed and denied decisions, and times them, as requests arrive', async () => {
    const { app, rule } = start('sliding-window-counter', workRule(), 'test-1', true);
    const client = newClient();
    const allowed = `ratelimit_decisions_total{rule="${rule.id}",outcome="allowed",source="primary"}`;
    const denied = `ratelimit_decisions_total{rule="${rule.id}",outcome="denied",source="primary"}`;
    const timed = `ratelimit_check_seconds_count{rule="${rule.id}",source="primary"}`;

    const before = (await request(app).get('/metrics')).text;
    expect(sample(before, allowed)).toBe(0);
    for (let i = 0; i <= LIMIT; i++) await request(app).get('/work').set('x-api-key', client);
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(sample(res.text, allowed)).toBe(LIMIT);
    expect(sample(res.text, denied)).toBe(1);
    expect(sample(res.text, timed)).toBe(LIMIT + 1);
  });

  it('is never limited, and scrapes are not counted as decisions, even under a catch-all rule', async () => {
    const everyRoute: Rule = { id: uniqueRuleId('bench'), limit: LIMIT, windowMs: 60_000 };
    const { app } = start('token-bucket', everyRoute, 'test-1', true);
    for (let i = 0; i < LIMIT * 3; i++) {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
      expect(res.text).not.toContain(`rule="${everyRoute.id}"`);
    }
  });

  it('is absent, and nothing is recorded, without METRICS', async () => {
    const { app } = start('sliding-window-counter');
    await request(app).get('/work').set('x-api-key', newClient());
    expect((await request(app).get('/metrics')).status).toBe(404);
  });

  it('gives each app its own registry, so two can run in one process', async () => {
    const one = start('token-bucket', workRule(), 'test-1', true);
    const two = start('token-bucket', workRule(), 'test-2', true);
    await request(one.app).get('/work').set('x-api-key', newClient());
    expect((await request(one.app).get('/metrics')).text).toContain(`rule="${one.rule.id}"`);
    expect((await request(two.app).get('/metrics')).text).not.toContain(`rule="${one.rule.id}"`);
  });

  it('reads METRICS as 1 or 0, and rejects anything else at startup', () => {
    expect(parseMetrics('1')).toBe(true);
    expect(parseMetrics('0')).toBe(false);
    expect(parseMetrics('')).toBe(false);
    expect(parseMetrics(undefined)).toBe(false);
    expect(() => parseMetrics('true')).toThrow('METRICS must be 1 or 0, not "true"');
  });
});

describe('Server-Timing', () => {
  const timing = /^rl;dur=(\d+\.\d{3})$/;

  it('is on allowed responses and on 429s', async () => {
    const { app } = start('sliding-window-counter');
    const client = newClient();
    const responses = [];
    for (let i = 0; i <= LIMIT; i++) {
      responses.push(await request(app).get('/work').set('x-api-key', client));
    }
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 429]);
    for (const res of responses) {
      const header = res.headers['server-timing'];
      expect(header).toMatch(timing);
      expect(Number(timing.exec(String(header))?.[1])).toBeGreaterThanOrEqual(0);
    }
  });

  it('is absent with none and on /healthz', async () => {
    const { app } = start('none');
    expect((await request(app).get('/work')).headers['server-timing']).toBeUndefined();
    const limited = start('token-bucket').app;
    expect((await request(limited).get('/healthz')).headers['server-timing']).toBeUndefined();
  });
});

describe('X-Instance', () => {
  it('names the instance, on every route', async () => {
    const { app } = start('fixed-window', workRule(), 'app-2');
    expect((await request(app).get('/healthz')).headers['x-instance']).toBe('app-2');
    expect((await request(app).get('/work')).headers['x-instance']).toBe('app-2');
  });
});

describe('X-Received-At', () => {
  it('stamps every response with when the instance received it, by the wall clock', async () => {
    const { app } = start('none');
    const before = Date.now();
    const res = await request(app).get('/work');
    const after = Date.now();
    const header = String(res.headers['x-received-at']);
    expect(header).toMatch(/^\d{13}$/);
    expect(Number(header)).toBeGreaterThanOrEqual(before);
    expect(Number(header)).toBeLessThanOrEqual(after);
  });
});

describe('behind one proxy', () => {
  async function statuses(app: BenchApp['app'], headers: Record<string, string>, n: number) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await request(app).get('/work').set(headers)).status);
    return out;
  }
  const full = [200, 200, 200, 429];

  // Each test's rule id is unique, so fixed addresses can't collide with earlier runs' keys.
  it('gives two forwarded addresses separate limits', async () => {
    const { app } = start('token-bucket');
    expect(await statuses(app, { 'x-forwarded-for': '198.51.100.7' }, LIMIT + 1)).toEqual(full);
    expect(await statuses(app, { 'x-forwarded-for': '203.0.113.7' }, LIMIT + 1)).toEqual(full);
  });

  it('gives two API keys from one address separate limits', async () => {
    const { app } = start('token-bucket');
    const from = { 'x-forwarded-for': '192.0.2.10' };
    expect(await statuses(app, { ...from, 'x-api-key': newClient() }, LIMIT + 1)).toEqual(full);
    expect(await statuses(app, { ...from, 'x-api-key': newClient() }, LIMIT + 1)).toEqual(full);
  });
});
