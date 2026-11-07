import express, { type Express } from 'express';
import { Histogram, Registry, register } from 'prom-client';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenBucket } from '../src/algorithms/token-bucket.js';
import type { DecisionEvent } from '../src/hooks.js';
import { rateLimit, type RateLimitMiddleware, type RateLimitOptions } from '../src/middleware.js';
import { DEFAULT_BUCKETS, prometheusHooks } from '../src/prometheus.js';
import type { Algorithm, Decision, Rule } from '../src/types.js';
import { FakeClock } from './helpers/fake-clock.js';
import { untilTimerPending } from './helpers/timers.js';

const rule: Rule = { id: 'api', limit: 2, windowMs: 3_600_000 };
const rejecting: Algorithm = { check: () => Promise.reject(new Error('store down')) };
const never: Algorithm = { check: () => new Promise<Decision>(() => undefined) };

const limiters: RateLimitMiddleware[] = [];
afterEach(() => {
  for (const limiter of limiters.splice(0)) limiter.close();
  vi.useRealTimers();
});

function app(opts: Partial<RateLimitOptions>): Express {
  const limiter = rateLimit({
    rules: [rule],
    algorithm: createTokenBucket({ clock: new FakeClock() }),
    ...opts,
  });
  limiters.push(limiter);
  const a = express();
  a.use(limiter);
  a.get('/{*rest}', (_req, res) => res.send('ok'));
  return a;
}

type Values = { labels: Record<string, string | number>; value: number; metricName?: string }[];

async function values(registry: Registry, name: string): Promise<Values> {
  const metric = registry.getSingleMetric(name);
  if (metric === undefined) throw new Error(`${name} is not registered`);
  return (await metric.get()).values as Values;
}

/** One sample's value, or 0 when no sample has those labels. */
async function sample(
  registry: Registry,
  name: string,
  labels: Record<string, string | number>,
  metricName = name,
): Promise<number> {
  const found = (await values(registry, name)).find(
    (v) =>
      (v.metricName ?? name) === metricName &&
      Object.keys(labels).length === Object.keys(v.labels).length &&
      Object.entries(labels).every(([k, want]) => v.labels[k] === want),
  );
  return found?.value ?? 0;
}

describe('prometheusHooks: metrics', () => {
  it('counts primary decisions by rule, outcome and source', async () => {
    const registry = new Registry();
    const a = app({ hooks: prometheusHooks({ registry }) });
    for (let i = 0; i < 3; i++) await request(a).get('/');

    const decisions = 'ratelimit_decisions_total';
    expect(
      await sample(registry, decisions, { rule: 'api', outcome: 'allowed', source: 'primary' }),
    ).toBe(2);
    expect(
      await sample(registry, decisions, { rule: 'api', outcome: 'denied', source: 'primary' }),
    ).toBe(1);
    expect(await values(registry, 'ratelimit_fallback_total')).toStrictEqual([]);
  });

  it('times every decision, in seconds, by rule and source', async () => {
    const registry = new Registry();
    const a = app({ hooks: prometheusHooks({ registry }) });
    for (let i = 0; i < 3; i++) await request(a).get('/');

    const check = 'ratelimit_check_seconds';
    const labels = { rule: 'api', source: 'primary' };
    expect(await sample(registry, check, labels, `${check}_count`)).toBe(3);
    // Every sample is counted in the +Inf bucket, and the top default bucket is 100 ms.
    expect(await sample(registry, check, { ...labels, le: '+Inf' }, `${check}_bucket`)).toBe(3);
  });

  it('converts durationMs to seconds', async () => {
    const registry = new Registry();
    const hooks = prometheusHooks({ registry, buckets: [0.001, 0.01] });
    const event = {
      rule,
      decision: { allowed: true, remaining: 1, resetMs: 1 },
      source: 'primary',
      durationMs: 5,
    } as unknown as DecisionEvent;
    hooks.onDecision?.(event);

    const check = 'ratelimit_check_seconds';
    const labels = { rule: 'api', source: 'primary' };
    expect(await sample(registry, check, labels, `${check}_sum`)).toBe(0.005);
    expect(await sample(registry, check, { ...labels, le: 0.001 }, `${check}_bucket`)).toBe(0);
    expect(await sample(registry, check, { ...labels, le: 0.01 }, `${check}_bucket`)).toBe(1);
  });

  it('counts fallbacks with reason "error", and their decisions with source "fallback"', async () => {
    const registry = new Registry();
    const a = app({ algorithm: rejecting, hooks: prometheusHooks({ registry }) });
    for (let i = 0; i < 3; i++) await request(a).get('/');

    expect(
      await sample(registry, 'ratelimit_fallback_total', { rule: 'api', reason: 'error' }),
    ).toBe(3);
    const decisions = 'ratelimit_decisions_total';
    expect(
      await sample(registry, decisions, { rule: 'api', outcome: 'allowed', source: 'fallback' }),
    ).toBe(2);
    expect(
      await sample(registry, decisions, { rule: 'api', outcome: 'denied', source: 'fallback' }),
    ).toBe(1);
    const check = 'ratelimit_check_seconds';
    expect(
      await sample(registry, check, { rule: 'api', source: 'fallback' }, `${check}_count`),
    ).toBe(3);
  });

  it('counts a fallback with reason "timeout" when the check hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const registry = new Registry();
    const a = app({ algorithm: never, hooks: prometheusHooks({ registry }) });
    const pending = request(a)
      .get('/')
      .then((res) => res);
    await untilTimerPending();
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending).status).toBe(200);

    expect(
      await sample(registry, 'ratelimit_fallback_total', { rule: 'api', reason: 'timeout' }),
    ).toBe(1);
  });

  it('labels by rule ID, never by client', async () => {
    const registry = new Registry();
    const a = app({ hooks: prometheusHooks({ registry }) });
    await request(a).get('/').set('x-forwarded-for', '203.0.113.7');
    await request(a).get('/').set('x-api-key', 'secret-key');

    const labels = [
      ...(await values(registry, 'ratelimit_decisions_total')),
      ...(await values(registry, 'ratelimit_check_seconds')),
    ].map((v) => Object.keys(v.labels).sort().join(','));
    expect(new Set(labels)).toStrictEqual(
      new Set(['outcome,rule,source', 'le,rule,source', 'rule,source']),
    );
  });
});

describe('prometheusHooks: options', () => {
  it('uses the prefix for every name', async () => {
    const registry = new Registry();
    const a = app({ hooks: prometheusHooks({ registry, prefix: 'api_rl_' }) });
    await request(a).get('/');

    const names = (await registry.getMetricsAsJSON()).map((m) => m.name).sort();
    expect(names).toStrictEqual([
      'api_rl_check_seconds',
      'api_rl_decisions_total',
      'api_rl_fallback_total',
    ]);
  });

  it('allows an empty prefix', () => {
    const registry = new Registry();
    prometheusHooks({ registry, prefix: '' });
    expect(registry.getSingleMetric('decisions_total')).toBeDefined();
  });

  it('uses the given buckets, and 0.1 ms to 100 ms by default', async () => {
    const custom = new Registry();
    prometheusHooks({ registry: custom, buckets: [0.002, 0.2] }).onDecision?.({
      rule,
      decision: { allowed: true, remaining: 1, resetMs: 1 },
      source: 'primary',
      durationMs: 1,
    } as unknown as DecisionEvent);
    const les = (await values(custom, 'ratelimit_check_seconds'))
      .filter((v) => v.metricName === 'ratelimit_check_seconds_bucket')
      .map((v) => v.labels.le);
    expect(les).toStrictEqual([0.002, 0.2, '+Inf']);

    expect(DEFAULT_BUCKETS[0]).toBe(0.0001);
    expect(DEFAULT_BUCKETS.at(-1)).toBe(0.1);
  });

  it("registers on prom-client's global registry when none is given", () => {
    const names = [
      'ratelimit_decisions_total',
      'ratelimit_fallback_total',
      'ratelimit_check_seconds',
    ];
    try {
      prometheusHooks();
      for (const name of names) expect(register.getSingleMetric(name)).toBeDefined();
    } finally {
      for (const name of names) register.removeSingleMetric(name);
    }
  });

  it.each([
    ['a number', 5],
    ['a dash', 'rate-limit_'],
    ['a leading digit', '9rl_'],
    ['a space', 'rl '],
  ])('throws at startup for a prefix with %s', (_, prefix) => {
    expect(() => prometheusHooks({ registry: new Registry(), prefix: prefix as string })).toThrow(
      /prometheusHooks: prefix/,
    );
  });

  it.each([
    ['empty', []],
    ['not an array', 0.1],
    ['unsorted', [0.2, 0.1]],
    ['a duplicate', [0.1, 0.1]],
    ['zero', [0, 0.1]],
    ['negative', [-1, 0.1]],
    ['NaN', [0.1, Number.NaN]],
    ['Infinity', [0.1, Number.POSITIVE_INFINITY]],
    ['a string', [0.1, '0.2']],
  ])('throws at startup for buckets that are %s', (_, buckets) => {
    expect(() =>
      prometheusHooks({ registry: new Registry(), buckets: buckets as number[] }),
    ).toThrow(/prometheusHooks: buckets/);
  });

  it.each([
    ['null', null],
    ['a string', 'registry'],
    ['an object without the methods', {}],
  ])('throws at startup for a registry that is %s', (_, registry) => {
    expect(() => prometheusHooks({ registry: registry as unknown as Registry })).toThrow(
      /prometheusHooks: registry must be a prom-client Registry/,
    );
  });
});

describe('prometheusHooks: called twice', () => {
  it('throws a clear error on the same registry', () => {
    const registry = new Registry();
    prometheusHooks({ registry });
    expect(() => prometheusHooks({ registry })).toThrow(
      'prometheusHooks: ratelimit_decisions_total is already registered on this registry. ' +
        'Call prometheusHooks() once per registry and share the hooks it returns.',
    );
  });

  it('registers nothing when any name is taken, even one it would register last', () => {
    const registry = new Registry();
    // Only the last name is taken, so a check-as-you-go would register the first two.
    new Histogram({ name: 'ratelimit_check_seconds', help: 'taken', registers: [registry] });
    expect(() => prometheusHooks({ registry })).toThrow(/ratelimit_check_seconds is already/);
    expect(registry.getSingleMetric('ratelimit_decisions_total')).toBeUndefined();
    expect(registry.getSingleMetric('ratelimit_fallback_total')).toBeUndefined();
  });

  it('works on two registries, or twice on one with different prefixes', () => {
    const one = new Registry();
    prometheusHooks({ registry: one });
    expect(() => prometheusHooks({ registry: new Registry() })).not.toThrow();
    expect(() => prometheusHooks({ registry: one, prefix: 'other_' })).not.toThrow();
  });
});
