import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTokenBucket,
  createTokenBucketForTest,
  type TokenBucket,
  type TokenBucketOptions,
} from '../../src/algorithms/token-bucket.js';
import type { Decision, Rule } from '../../src/types.js';
import { FakeClock } from '../helpers/fake-clock.js';

const T0 = Date.UTC(2026, 0, 1);

const open: TokenBucket[] = [];

function setup(rule: Rule, opts: TokenBucketOptions = {}) {
  const clock = new FakeClock(T0);
  const bucket = createTokenBucketForTest({ clock, ...opts });
  open.push(bucket);
  const check = (key = 'rl:test:client', r: Rule = rule) => bucket.check(key, r);
  return { clock, bucket, check };
}

async function countAllowed(check: () => Promise<Decision>, max = 10_000): Promise<number> {
  let allowed = 0;
  while (allowed < max && (await check()).allowed) allowed++;
  return allowed;
}

afterEach(() => {
  for (const bucket of open.splice(0)) bucket.close();
  vi.useRealTimers();
});

describe('burst', () => {
  it('says it takes a burst', () => {
    expect(setup({ id: 'r', limit: 1, windowMs: 1 }).bucket.supportsBurst).toBe(true);
  });

  it('allows burst at once, then limit per windowMs', async () => {
    // 60 a minute, at most 10 at once: one token a second.
    const { clock, check } = setup({ id: 'r', limit: 60, windowMs: 60_000, burst: 10 });
    expect(await check()).toStrictEqual({ allowed: true, remaining: 9, resetMs: 1_000 });
    expect(await countAllowed(check)).toBe(9);
    expect(await check()).toStrictEqual({ allowed: false, remaining: 0, resetMs: 1_000 });
    clock.advance(1_000);
    expect(await check()).toMatchObject({ allowed: true, remaining: 0 });
    // A long wait refills to the burst, not to the limit.
    clock.advance(3_600_000);
    expect(await countAllowed(check)).toBe(10);
  });

  it('can be larger than the limit', async () => {
    const { clock, check } = setup({ id: 'r', limit: 2, windowMs: 1_000, burst: 5 });
    expect(await countAllowed(check)).toBe(5);
    clock.advance(500);
    expect(await countAllowed(check)).toBe(1);
  });

  it('carries whole tokens over when the burst changes, never more than the new one', async () => {
    const rule: Rule = { id: 'r', limit: 60, windowMs: 60_000, burst: 10 };
    const { clock, check } = setup(rule);
    for (let i = 0; i < 2; i++) await check(); // 8 left
    // Cut to 5: the 8 tokens become 5.
    expect(await check(undefined, { ...rule, burst: 5 })).toMatchObject({ remaining: 4 });
    // Raised to 20: the 4 carry over, with no free refill.
    const raised = { ...rule, burst: 20 };
    expect(await check(undefined, raised)).toMatchObject({ remaining: 3 });
    // And it refills to the new burst, one a second.
    clock.advance(17_000);
    expect(await countAllowed(() => check(undefined, raised))).toBe(20);
  });

  it('treats a burst equal to the limit as no burst at all', async () => {
    const rule: Rule = { id: 'r', limit: 5, windowMs: 1_000 };
    const plain = setup(rule);
    const same = setup({ ...rule, burst: 5 });
    for (let i = 0; i < 8; i++) {
      expect(await same.check()).toStrictEqual(await plain.check());
      plain.clock.advance(150);
      same.clock.advance(150);
    }
  });
});

describe('createTokenBucket', () => {
  it('allows exactly limit requests for a new key, then denies', async () => {
    const { check } = setup({ id: 'r', limit: 5, windowMs: 1_000 });
    const remaining: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await check();
      expect(d.allowed).toBe(true);
      remaining.push(d.remaining);
    }
    expect(remaining).toEqual([4, 3, 2, 1, 0]);
    expect(await check()).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('reports time until full when allowed', async () => {
    const { check } = setup({ id: 'r', limit: 10, windowMs: 1_000 });
    expect((await check()).resetMs).toBe(100);
    expect((await check()).resetMs).toBe(200);
  });

  it.each([
    { limit: 10, windowMs: 1_000, expectedResetMs: 100 },
    // A token every 333.33… ms: the awkward rate that breaks float-based buckets.
    { limit: 3, windowMs: 1_000, expectedResetMs: 334 },
    { limit: 7, windowMs: 999, expectedResetMs: 143 },
  ])(
    'after a denial, resetMs is the time to one token (limit $limit, windowMs $windowMs)',
    async ({ limit, windowMs, expectedResetMs }) => {
      const { clock, check } = setup({ id: 'r', limit, windowMs });
      expect(await countAllowed(check)).toBe(limit);

      const denied = await check();
      expect(denied).toMatchObject({ allowed: false, resetMs: expectedResetMs });

      clock.advance(denied.resetMs - 1);
      expect((await check()).allowed).toBe(false);

      clock.advance(1);
      expect(await countAllowed(check)).toBe(1);
    },
  );

  // The last three pairs leave a float-based bucket at 0.9999999999999999 tokens after
  // waiting exactly resetMs, which is why the bucket counts in integer units.
  it.each([
    { limit: 3, windowMs: 1_000 },
    { limit: 99, windowMs: 1_001 },
    { limit: 167, windowMs: 3_000 },
    { limit: 48, windowMs: 86_400_000 },
  ])(
    'waiting exactly resetMs after each denial yields exactly one request ($limit per $windowMs ms)',
    async ({ limit, windowMs }) => {
      const { clock, check } = setup({ id: 'r', limit, windowMs });
      await countAllowed(check);
      for (let i = 0; i < 200; i++) {
        const denied = await check();
        expect(denied.allowed).toBe(false);
        clock.advance(denied.resetMs);
        expect(await countAllowed(check)).toBe(1);
      }
    },
  );

  it.each([
    { limit: 10, expected: 5 },
    { limit: 7, expected: 3 },
  ])('refills partially: half a window gives back floor(limit / 2) ($limit)', async (c) => {
    const { clock, check } = setup({ id: 'r', limit: c.limit, windowMs: 1_000 });
    await countAllowed(check);
    clock.advance(500);
    expect(await countAllowed(check)).toBe(c.expected);
  });

  it('never refills above limit after a long idle period', async () => {
    const { clock, check } = setup({ id: 'r', limit: 4, windowMs: 1_000 });
    await check();
    clock.advance(100 * 1_000);
    expect(await countAllowed(check)).toBe(4);
  });

  it('keeps separate keys independent', async () => {
    const { check } = setup({ id: 'r', limit: 2, windowMs: 1_000 });
    expect(await countAllowed(() => check('rl:r:a'))).toBe(2);
    expect(await countAllowed(() => check('rl:r:b'))).toBe(2);
  });

  it('keeps separate rules independent for the same client', async () => {
    const strict: Rule = { id: 'strict', limit: 1, windowMs: 1_000 };
    const loose: Rule = { id: 'loose', limit: 3, windowMs: 1_000 };
    const { check } = setup(strict);
    expect(await countAllowed(() => check('rl:strict:a', strict))).toBe(1);
    expect(await countAllowed(() => check('rl:loose:a', loose))).toBe(3);
  });

  it('does not add tokens when the clock goes backwards, or when it returns', async () => {
    const { clock, check } = setup({ id: 'r', limit: 10, windowMs: 1_000 });
    clock.set(T0 + 1_000);
    await countAllowed(check);

    clock.set(T0 + 500);
    expect(await check()).toMatchObject({ allowed: false, remaining: 0 });

    // Returning to the original time must not refill the 500 ms span a second time.
    clock.set(T0 + 1_000);
    expect((await check()).allowed).toBe(false);

    clock.set(T0 + 1_100);
    expect(await countAllowed(check)).toBe(1);
  });

  it('carries over whole tokens only when the rule changes under a key', async () => {
    const { clock, check } = setup({ id: 'r', limit: 10, windowMs: 1_000 });
    await countAllowed(check);
    clock.advance(250); // 2.5 tokens under the old rule

    const changed: Rule = { id: 'r', limit: 4, windowMs: 2_000 };
    expect(await countAllowed(() => check(undefined, changed))).toBe(2);

    const shrunk: Rule = { id: 'r', limit: 1, windowMs: 2_000 };
    clock.advance(100_000);
    expect(await countAllowed(() => check(undefined, changed))).toBe(4);
    clock.advance(100_000);
    expect(await countAllowed(() => check(undefined, shrunk))).toBe(1);
  });

  it('keeps remaining and resetMs as non-negative integers', async () => {
    const rules: Rule[] = [
      { id: 'a', limit: 10, windowMs: 1_000 },
      { id: 'b', limit: 3, windowMs: 1_000 },
      { id: 'c', limit: 7, windowMs: 999 },
      { id: 'd', limit: 1, windowMs: 1 },
      { id: 'e', limit: 1_000, windowMs: 86_400_000 },
    ];
    // Park-Miller generator: deterministic but irregular, and exact in float64.
    let seed = 42;
    const next = (n: number) => (seed = (seed * 48_271) % 2_147_483_647) % n;

    for (const rule of rules) {
      const { clock, check } = setup(rule);
      for (let i = 0; i < 300; i++) {
        const d = await check();
        expect(Number.isInteger(d.remaining) && d.remaining >= 0).toBe(true);
        expect(Number.isInteger(d.resetMs) && d.resetMs >= 0).toBe(true);
        if (next(3) === 0) clock.advance(next(rule.windowMs + 1));
      }
    }
  });

  describe('sweep', () => {
    it('removes full buckets and keeps partial ones', async () => {
      const { clock, bucket, check } = setup({ id: 'r', limit: 10, windowMs: 1_000 });
      await check('rl:r:light');
      await countAllowed(() => check('rl:r:heavy'));
      expect(bucket.size).toBe(2);

      clock.advance(100); // light is full again; heavy has one token
      bucket.sweep();
      expect(bucket.size).toBe(1);
      expect(await countAllowed(() => check('rl:r:heavy'))).toBe(1);
    });

    it('runs on the interval, and close() stops the timer', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { clock, bucket, check } = setup(
        { id: 'r', limit: 2, windowMs: 1_000 },
        { sweepIntervalMs: 5_000 },
      );
      await check();
      expect(vi.getTimerCount()).toBe(1);

      clock.advance(1_000);
      vi.advanceTimersByTime(4_999);
      expect(bucket.size).toBe(1);
      vi.advanceTimersByTime(1);
      expect(bucket.size).toBe(0);

      bucket.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(() => {
        bucket.close();
      }).not.toThrow();
      expect((await check()).allowed).toBe(true);
    });
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648, 3_000_000_000])(
    'rejects sweepIntervalMs %s at construction',
    (ms) => {
      expect(() => createTokenBucket({ sweepIntervalMs: ms })).toThrow(RangeError);
    },
  );

  it('accepts the longest sweepIntervalMs a Node timer holds', () => {
    const bucket = createTokenBucket({ sweepIntervalMs: 2_147_483_647 });
    open.push(bucket);
    expect(bucket.supportsBurst).toBe(true);
  });

  it('exposes only check, close and supportsBurst, not the test-only sweep and size', () => {
    const bucket = createTokenBucket();
    open.push(bucket);
    expect(Object.keys(bucket).sort()).toEqual(['check', 'close', 'supportsBurst']);
  });

  it('defaults to the system clock', async () => {
    const bucket = createTokenBucket();
    open.push(bucket);
    expect(await bucket.check('k', { id: 'r', limit: 1, windowMs: 1_000 })).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });
});
