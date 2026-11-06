import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildKey } from '../../src/identify.js';
import type { Algorithm, Decision, Rule } from '../../src/types.js';
import type { FakeClock } from '../helpers/fake-clock.js';

/**
 * The behaviour every Algorithm must have, in memory or in Redis. Each algorithm's own test file
 * calls describeAlgorithm. Properties that differ between algorithms come from `traits`.
 */

export interface AlgorithmUnderTest {
  algorithm: Algorithm;
  /** Drives the algorithm's time. For Redis, through the internal test-only time override. */
  clock: FakeClock;
  close?: () => void | Promise<void>;
}

export interface AlgorithmTraits {
  /** How many requests a new key allows at once. */
  burst(rule: Rule): number;
  /** The most requests any windowMs-wide span may allow, under traffic faster than the limit. */
  maxPerWindow(rule: Rule): number;
}

/**
 * Every rule here uses windowMs of 60 s or more. Redis keys expire in real time even when a test
 * drives time with FakeClock, so a short window could expire mid-test and quietly reset state.
 */
function freshRule(overrides: Partial<Omit<Rule, 'id'>> = {}): Rule {
  return { id: `contract:${randomUUID()}`, limit: 5, windowMs: 60_000, ...overrides };
}

const ruleShapes: [string, Partial<Omit<Rule, 'id'>>][] = [
  ['limit 1', { limit: 1 }],
  ['limit 5 per minute', { limit: 5 }],
  // Exact float maths lands on 0.999… tokens here (milestone 1 spec); integer state must not.
  ['limit 48 per day', { limit: 48, windowMs: 86_400_000 }],
];

export function describeAlgorithm(
  name: string,
  setup: () => AlgorithmUnderTest | Promise<AlgorithmUnderTest>,
  traits: AlgorithmTraits,
): void {
  describe(`${name}: behaviour suite`, () => {
    let t: AlgorithmUnderTest;
    beforeEach(async () => {
      t = await setup();
    });
    afterEach(async () => {
      await t.close?.();
    });

    const check = (rule: Rule, client = 'client'): Promise<Decision> =>
      t.algorithm.check(buildKey(rule, client), rule);

    /** Makes requests until one is denied, and returns that denial. */
    async function exhaust(rule: Rule, client = 'client'): Promise<Decision> {
      for (let i = 0; i <= traits.burst(rule); i++) {
        const decision = await check(rule, client);
        if (!decision.allowed) return decision;
      }
      throw new Error('still allowed after a full burst');
    }

    describe.each(ruleShapes)('with %s', (_label, shape) => {
      it('allows exactly its burst for a new key, counting remaining down to 0, then denies', async () => {
        const rule = freshRule(shape);
        const burst = traits.burst(rule);
        for (let n = 1; n <= burst; n++) {
          const decision = await check(rule);
          expect(decision.allowed).toBe(true);
          expect(decision.remaining).toBe(burst - n);
        }
        expect((await check(rule)).allowed).toBe(false);
      });

      it('after a denial, allows the next request at exactly resetMs, and not 1 ms sooner', async () => {
        const rule = freshRule(shape);
        const denied = await exhaust(rule);
        expect(denied.resetMs).toBeGreaterThan(0);

        t.clock.advance(denied.resetMs - 1);
        expect((await check(rule)).allowed).toBe(false);
        t.clock.advance(1);
        expect((await check(rule)).allowed).toBe(true);
      });

      it('after an allowed request, gives back a full burst once its resetMs has passed', async () => {
        const rule = freshRule(shape);
        let last: Decision | undefined;
        for (let i = 0; i < traits.burst(rule); i++) last = await check(rule);
        if (last === undefined) throw new Error('burst must be at least 1');

        t.clock.advance(last.resetMs);
        for (let i = 0; i < traits.burst(rule); i++) {
          expect((await check(rule)).allowed).toBe(true);
        }
        expect((await check(rule)).allowed).toBe(false);
      });
    });

    it('does not charge for denied requests', async () => {
      const rule = freshRule();
      const first = await exhaust(rule);
      for (let i = 0; i < 10; i++) {
        expect(await check(rule)).toStrictEqual(first);
      }
      t.clock.advance(first.resetMs);
      expect((await check(rule)).allowed).toBe(true);
    });

    it('keeps remaining and resetMs whole and non-negative, at uneven times', async () => {
      const rule = freshRule({ limit: 7, windowMs: 90_001 });
      const gaps = [0, 1, 7, 13, 999, 1, 12_857, 3, 30_001, 0, 2, 90_001, 5, 17, 44_444, 1, 0];
      for (const gap of gaps) {
        t.clock.advance(gap);
        const { remaining, resetMs } = await check(rule);
        expect(Number.isSafeInteger(remaining) && remaining >= 0).toBe(true);
        expect(Number.isSafeInteger(resetMs) && resetMs >= 0).toBe(true);
      }
    });

    it('keeps separate clients under one rule apart', async () => {
      const rule = freshRule();
      await exhaust(rule, 'a');
      expect((await check(rule, 'b')).allowed).toBe(true);
    });

    it('keeps one client under separate rules apart', async () => {
      const first = freshRule();
      const second = freshRule();
      await exhaust(first);
      expect((await check(second)).allowed).toBe(true);
    });

    it('treats a clock that goes backwards as standing still, then returning', async () => {
      const rule = freshRule();
      const denied = await exhaust(rule);
      const now = t.clock.now();

      // Time only moves forward: while the clock is behind, every decision is the one it would
      // be at the latest time seen. No extra capacity, and no longer wait either.
      t.clock.set(now - 3_600_000);
      expect(await check(rule)).toStrictEqual(denied);
      t.clock.set(now);
      expect(await check(rule)).toStrictEqual(denied);
    });

    it('never allows more than its maximum in any windowMs span, under steady traffic', async () => {
      const rule = freshRule({ limit: 5 });
      // Four times faster than the limit, for five windows.
      const interval = rule.windowMs / (4 * rule.limit);
      const allowedAt: number[] = [];
      for (let elapsed = 0; elapsed < 5 * rule.windowMs; elapsed += interval) {
        if ((await check(rule)).allowed) allowedAt.push(elapsed);
        t.clock.advance(interval);
      }

      const busiest = Math.max(
        ...allowedAt.map(
          (start) => allowedAt.filter((at) => at >= start && at < start + rule.windowMs).length,
        ),
      );
      expect(busiest).toBeLessThanOrEqual(traits.maxPerWindow(rule));
      // Saturated traffic should reach at least the limit, or the test isn't testing anything.
      expect(busiest).toBeGreaterThanOrEqual(rule.limit);
    });

    it('never allows more than the new burst when a rule shrinks under the same key', async () => {
      const big = freshRule({ limit: 10 });
      await check(big);
      await check(big);
      const small = { ...big, limit: 3 };

      let allowed = 0;
      for (let i = 0; i < 10; i++) if ((await check(small)).allowed) allowed++;
      expect(allowed).toBeLessThanOrEqual(traits.burst(small));
    });
  });
}
