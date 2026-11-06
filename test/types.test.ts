import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Algorithm, Decision, Rule } from '../src/index.js';

// These are compile-time checks enforced by `npm run typecheck`. An unused
// ts-expect-error directive fails it, so each one proves the types reject that shape.
describe('public types', () => {
  it('accepts an algorithm whose check returns Promise<Decision>', async () => {
    const algorithm = {
      check: (_key: string, rule: Rule) =>
        Promise.resolve({ allowed: true, remaining: rule.limit - 1, resetMs: 0 }),
    } satisfies Algorithm;

    expectTypeOf(algorithm.check).returns.resolves.toExtend<Decision>();
    await expect(algorithm.check('k', { id: 'r', limit: 3, windowMs: 1_000 })).resolves.toEqual({
      allowed: true,
      remaining: 2,
      resetMs: 0,
    });
  });

  it('rejects a synchronous check', () => {
    const algorithm: Algorithm = {
      // @ts-expect-error check must return a Promise, even for in-memory algorithms (decision 0001)
      check: (): Decision => ({ allowed: true, remaining: 0, resetMs: 0 }),
    };
    expect(algorithm).toBeDefined();
  });

  it('needs only id, limit and windowMs on a rule', () => {
    const rule = { id: 'global', limit: 100, windowMs: 60_000 } satisfies Rule;
    expectTypeOf(rule).toExtend<Rule>();

    // @ts-expect-error windowMs is required
    const missingWindow: Rule = { id: 'global', limit: 100 };
    expect(missingWindow).toBeDefined();
  });
});
