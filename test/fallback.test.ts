import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withDefaultBurst } from '../src/algorithms/default-burst.js';
import { createFallback, fallbackRule, scaleRule } from '../src/fallback.js';
import type { Rule } from '../src/types.js';
import { FakeClock } from './helpers/fake-clock.js';

const rule: Rule = { id: 'global', limit: 10, windowMs: 60_000 };

describe('scaleRule', () => {
  it.each([
    // [limit, instances, each instance's share]
    [10, 1, 10],
    [9, 3, 3],
    [10, 3, 4], // rounds up: 3 instances × 4 = 12, slightly over rather than under
    [100, 7, 15],
    [2, 3, 1], // fewer requests than instances: still 1, never 0
    [1, 1000, 1],
  ])('limit %i over %i instances gives %i each', (limit, instances, expected) => {
    expect(scaleRule({ ...rule, limit }, instances).limit).toBe(expected);
  });

  it.each([
    // [burst, instances, each instance's share]
    [10, 3, 4],
    [9, 3, 3],
    [2, 3, 1],
    [50, 1, 50],
  ])('shares a burst of %i over %i instances as %i each', (burst, instances, expected) => {
    expect(scaleRule({ ...rule, burst }, instances).burst).toBe(expected);
  });

  it('adds no burst to a rule without one', () => {
    expect(scaleRule(rule, 3)).not.toHaveProperty('burst');
  });

  it('keeps everything but the limit', () => {
    const full: Rule = { ...rule, method: 'POST', path: '/orders', tier: 'free' };
    expect(scaleRule(full, 3)).toStrictEqual({ ...full, limit: 4 });
  });

  it('returns the rule itself for one instance', () => {
    expect(scaleRule(rule, 1)).toBe(rule);
  });
});

describe('fallbackRule', () => {
  const plain = () => ({
    check: () => Promise.resolve({ allowed: true, remaining: 0, resetMs: 0 }),
  });

  it("gives the rule its algorithm's default burst, where that isn't the limit", () => {
    expect(fallbackRule(rule, withDefaultBurst(plain(), 1))).toStrictEqual({ ...rule, burst: 1 });
  });

  it("keeps the rule's own burst", () => {
    const own = { ...rule, burst: 4 };
    expect(fallbackRule(own, withDefaultBurst(plain(), 1))).toBe(own);
  });

  it('leaves the rule alone for an algorithm without a default burst', () => {
    expect(fallbackRule(rule, plain())).toBe(rule);
  });
});

describe('createFallback', () => {
  // The bucket's sweep runs on setInterval, so the timer count shows whether a bucket exists.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the scaled limit per window, then denies, and returns the scaled rule', async () => {
    const clock = new FakeClock();
    const fallback = createFallback(3, clock);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await fallback.check('rl:global:a', rule));

    expect(results.map((r) => r.decision.allowed)).toStrictEqual([true, true, true, true, false]);
    expect(results[0]?.rule.limit).toBe(4);
    expect(results[0]?.decision.remaining).toBe(3);

    // A token bucket refills one token every windowMs / limit.
    clock.advance(60_000 / 4);
    expect((await fallback.check('rl:global:a', rule)).decision.allowed).toBe(true);
    fallback.close();
  });

  it('creates no bucket until the first check, and close() stops it', async () => {
    const fallback = createFallback(1, new FakeClock());
    expect(vi.getTimerCount()).toBe(0);
    await fallback.check('rl:global:a', rule);
    expect(vi.getTimerCount()).toBe(1);
    fallback.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still answers after close(), without starting a timer', async () => {
    const fallback = createFallback(1, new FakeClock());
    fallback.close();
    expect((await fallback.check('rl:global:a', rule)).decision.allowed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
