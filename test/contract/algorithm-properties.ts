import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildKey } from '../../src/identify.js';
import type { Algorithm, Clock, Decision, Rule } from '../../src/types.js';
import { FakeClock } from '../helpers/fake-clock.js';
import type { AlgorithmUnderTest } from './algorithm-contract.js';

/**
 * Property tests (decision 0034): rules every Algorithm must keep over any history of checks,
 * which fast-check generates and, when one breaks a rule, shrinks to the smallest that still does.
 * The behaviour suite in algorithm-contract.ts checks the same ideas at a few chosen points.
 */

/** What differs between algorithms. */
export interface PropertyTraits {
  readonly supportsBurst: boolean;
  /** How many requests a new key, or one fully restored, allows at once. */
  burst(rule: Rule): number;
  /** The most requests one client may be allowed at times in [startMs, startMs + spanMs]. */
  maxInSpan(rule: Rule, startMs: number, spanMs: number): number;
}

/** Windows aligned to the epoch: at most `limit` in each one the span touches. */
function perAlignedWindow(rule: Rule, startMs: number, spanMs: number): number {
  const windows =
    Math.floor((startMs + spanMs) / rule.windowMs) - Math.floor(startMs / rule.windowMs) + 1;
  return rule.limit * windows;
}

export const traits = {
  // A full bucket, plus what refills over the span: tokens are whole, so the fraction is lost.
  tokenBucket: {
    supportsBurst: true,
    burst: (rule) => rule.burst ?? rule.limit,
    maxInSpan: (rule, _start, span) =>
      (rule.burst ?? rule.limit) + Math.floor((span * rule.limit) / rule.windowMs),
  },
  fixedWindow: { supportsBurst: false, burst: (rule) => rule.limit, maxInSpan: perAlignedWindow },
  // Exact: at most `limit` in any windowMs, so in each windowMs-long piece of the span.
  slidingWindowLog: {
    supportsBurst: false,
    burst: (rule) => rule.limit,
    maxInSpan: (rule, _start, span) => rule.limit * Math.ceil((span + 1) / rule.windowMs),
  },
  // The current window's count alone must stay within the limit, whatever the previous one held.
  slidingWindowCounter: {
    supportsBurst: false,
    burst: (rule) => rule.limit,
    maxInSpan: perAlignedWindow,
  },
  // GCRA in whole ms: a slot is taken in the ms it falls in, and burst - 1 slots early. So
  // span + 1 ms of slots, plus the early ones.
  leakyBucket: {
    supportsBurst: true,
    burst: (rule) => (rule.burst ?? 1) - 1 + Math.ceil(rule.limit / rule.windowMs),
    maxInSpan: (rule, _start, span) =>
      (rule.burst ?? 1) - 1 + Math.ceil(((span + 1) * rule.limit) / rule.windowMs),
  },
} satisfies Record<string, PropertyTraits>;

export type RuleShape = Omit<Rule, 'id'>;

export interface Step {
  /** ms to move the clock; negative steps it back. */
  readonly advanceMs: number;
  /** Which of the history's rules to check against. Both share one ID, as in 0031. */
  readonly rule: 0 | 1;
  readonly client: 'a' | 'b';
}

export interface History {
  readonly rules: readonly [RuleShape, RuleShape];
  readonly steps: readonly Step[];
}

export interface HistoryOptions {
  readonly supportsBurst: boolean;
  /** A second rule on the same key, now and then. */
  readonly twoRules: boolean;
  readonly twoClients: boolean;
  /** The clock stepping back, now and then. */
  readonly back: boolean;
  readonly maxSteps: number;
}

/**
 * Mostly short windows and small limits, so a few dozen checks reach every state: empty, full,
 * across a boundary, after a rule change. Now and then a long one, or a rate faster than one per
 * ms. Shrinking moves towards limit 1, windowMs 1 and no burst.
 */
export function ruleShape(supportsBurst: boolean): fc.Arbitrary<RuleShape> {
  const limit = fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 1, max: 12 }) },
    { weight: 1, arbitrary: fc.constantFrom(48, 1_000) },
  );
  const windowMs = fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 1, max: 20 }) },
    { weight: 1, arbitrary: fc.constantFrom(1_000, 60_000, 86_400_000) },
  );
  const burst = supportsBurst
    ? fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined })
    : fc.constant(undefined);
  return fc
    .record({ limit, windowMs, burst })
    .map(({ burst: b, ...rest }) => (b === undefined ? rest : { ...rest, burst: b }));
}

function advance(windowMs: number, back: boolean): fc.Arbitrary<number> {
  const span = Math.min(3 * windowMs, 2 ** 40);
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant(0) },
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 3 }) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: span }) },
    ...(back ? [{ weight: 1, arbitrary: fc.integer({ min: -span, max: -1 }) }] : []),
  );
}

export function history(opts: HistoryOptions): fc.Arbitrary<History> {
  return fc.tuple(ruleShape(opts.supportsBurst), ruleShape(opts.supportsBurst)).chain((rules) => {
    const step = fc.record({
      advanceMs: advance(rules[0].windowMs, opts.back),
      // One check in eight on the second rule. Shrinks to the first.
      rule: opts.twoRules
        ? fc.integer({ min: 0, max: 7 }).map((n): 0 | 1 => (n === 7 ? 1 : 0))
        : fc.constant<0 | 1>(0),
      client: opts.twoClients
        ? fc.boolean().map((b): 'a' | 'b' => (b ? 'b' : 'a'))
        : fc.constant<'a' | 'b'>('a'),
    });
    return fc.record({
      rules: fc.constant(rules),
      steps: fc.array(step, { minLength: 1, maxLength: opts.maxSteps, size: 'max' }),
    });
  });
}

export interface Checked {
  /** The clock when checked. */
  readonly at: number;
  /** The latest time this client's key has seen, which is the time the algorithm uses. */
  readonly seen: number;
  readonly rule: Rule;
  readonly client: 'a' | 'b';
  readonly decision: Decision;
}

/** Rules with a fresh ID, so every run starts with new keys. */
function withId(h: History): readonly [Rule, Rule] {
  const id = `prop:${randomUUID()}`;
  return [
    { id, ...h.rules[0] },
    { id, ...h.rules[1] },
  ];
}

/** Times are absolute, from FakeClock's default start, so two runs of one history line up. */
async function replay(
  algorithm: Algorithm,
  clock: FakeClock,
  rules: readonly [Rule, Rule],
  steps: readonly { at: number; rule: 0 | 1; client: 'a' | 'b' }[],
): Promise<Checked[]> {
  const seen = new Map<string, number>();
  const out: Checked[] = [];
  for (const step of steps) {
    const rule = rules[step.rule];
    clock.set(step.at);
    const decision = await algorithm.check(buildKey(rule, step.client), rule);
    const latest = Math.max(step.at, seen.get(step.client) ?? step.at);
    seen.set(step.client, latest);
    out.push({ at: step.at, seen: latest, rule, client: step.client, decision });
  }
  return out;
}

const START = new FakeClock().now();

function timed(steps: readonly Step[]): { at: number; rule: 0 | 1; client: 'a' | 'b' }[] {
  let at = START;
  return steps.map((s) => {
    at += s.advanceMs;
    return { at, rule: s.rule, client: s.client };
  });
}

async function using<T>(
  setup: () => AlgorithmUnderTest | Promise<AlgorithmUnderTest>,
  run: (t: AlgorithmUnderTest) => Promise<T>,
): Promise<T> {
  const t = await setup();
  try {
    return await run(t);
  } finally {
    await t.close?.();
  }
}

/**
 * FC_SEED replays a failure: fast-check prints the seed. FC_RUNS multiplies every numRuns, for a
 * longer search than CI's, as in FC_RUNS=20 npm run test:integration.
 */
export function runParameters(numRuns: number): fc.Parameters<unknown> {
  const seed = process.env.FC_SEED;
  const scale = Number(process.env.FC_RUNS ?? 1);
  return {
    numRuns: Math.max(1, Math.round(numRuns * scale)),
    ...(seed === undefined ? {} : { seed: Number(seed) }),
  };
}

export interface PropertyOptions {
  readonly numRuns: number;
  readonly maxSteps: number;
  /** Per property, in ms. */
  readonly timeout: number;
}

export function describeAlgorithmProperties(
  name: string,
  setup: () => AlgorithmUnderTest | Promise<AlgorithmUnderTest>,
  t: PropertyTraits,
  opts: PropertyOptions,
): void {
  const base = { supportsBurst: t.supportsBurst, maxSteps: opts.maxSteps };
  const anyHistory = history({ ...base, twoRules: true, twoClients: true, back: true });
  const oneRule = history({ ...base, twoRules: false, twoClients: false, back: false });
  const run = (h: History, a: AlgorithmUnderTest, steps = timed(h.steps)) =>
    replay(a.algorithm, a.clock, withId(h), steps);
  const params = runParameters(opts.numRuns);

  describe(`${name}: properties`, () => {
    it(
      'keeps every decision well formed: whole numbers, a wait when denied, remaining within the burst',
      async () => {
        await fc.assert(
          fc.asyncProperty(anyHistory, (h) =>
            using(setup, async (a) => {
              for (const { decision, rule } of await run(h, a)) {
                expect(Number.isSafeInteger(decision.remaining)).toBe(true);
                expect(Number.isSafeInteger(decision.resetMs)).toBe(true);
                if (decision.allowed) {
                  expect(decision.resetMs).toBeGreaterThanOrEqual(0);
                  expect(decision.remaining).toBeGreaterThanOrEqual(0);
                  expect(decision.remaining).toBeLessThan(t.burst(rule));
                } else {
                  expect(decision.resetMs).toBeGreaterThanOrEqual(1);
                  expect(decision.remaining).toBe(0);
                }
              }
            }),
          ),
          params,
        );
      },
      opts.timeout,
    );

    it(
      'never allows more than its maximum in any span, under one rule',
      async () => {
        await fc.assert(
          fc.asyncProperty(oneRule, (h) =>
            using(setup, async (a) => {
              const times = (await run(h, a)).filter((c) => c.decision.allowed).map((c) => c.at);
              const rule = { id: '', ...h.rules[0] };
              // Every span from one allowed request to another. Plain comparisons, then one
              // expect for the first breach: expect on every pair is too slow for long histories.
              let breach: string | undefined;
              for (let i = 0; i < times.length && breach === undefined; i++) {
                for (let j = i; j < times.length && breach === undefined; j++) {
                  const [from = 0, to = 0] = [times[i], times[j]];
                  const max = t.maxInSpan(rule, from, to - from);
                  if (j - i + 1 > max) {
                    breach = `${String(j - i + 1)} allowed in ${String(from)}..${String(to)}, max ${String(max)}`;
                  }
                }
              }
              expect(breach).toBeUndefined();
            }),
          ),
          params,
        );
      },
      opts.timeout,
    );

    it(
      'treats a clock that steps back as standing still: the same decisions as at the latest time seen',
      async () => {
        await fc.assert(
          fc.asyncProperty(anyHistory, async (h) => {
            const steps = timed(h.steps);
            const asIs = await using(setup, (a) => run(h, a, steps));
            // Each client's key keeps its own latest time.
            const latest = new Map<string, number>();
            const held = steps.map((s) => {
              const at = Math.max(s.at, latest.get(s.client) ?? s.at);
              latest.set(s.client, at);
              return { ...s, at };
            });
            const forward = await using(setup, (a) => run(h, a, held));
            expect(asIs.map((c) => c.decision)).toStrictEqual(forward.map((c) => c.decision));
          }),
          params,
        );
      },
      opts.timeout,
    );

    it(
      'does not charge for denied requests: without them, the rest get the same answers',
      async () => {
        await fc.assert(
          fc.asyncProperty(oneRule, async (h) => {
            const steps = timed(h.steps);
            const all = await using(setup, (a) => run(h, a, steps));
            const kept = steps.filter((_, i) => all[i]?.decision.allowed === true);
            const without = await using(setup, (a) => run(h, a, kept));
            expect(without.map((c) => c.decision)).toStrictEqual(
              all.filter((c) => c.decision.allowed).map((c) => c.decision),
            );
          }),
          params,
        );
      },
      opts.timeout,
    );

    it(
      'keeps clients apart: each gets the answers it would get alone',
      async () => {
        await fc.assert(
          fc.asyncProperty(anyHistory, async (h) => {
            const steps = timed(h.steps);
            const together = await using(setup, (a) => run(h, a, steps));
            for (const client of ['a', 'b'] as const) {
              const own = steps.filter((s) => s.client === client);
              const alone = await using(setup, (a) => run(h, a, own));
              expect(alone.map((c) => c.decision)).toStrictEqual(
                together.filter((c) => c.client === client).map((c) => c.decision),
              );
            }
          }),
          params,
        );
      },
      opts.timeout,
    );

    it(
      'after any history, a denial waits exactly resetMs: denied 1 ms sooner, allowed at it',
      async () => {
        await fc.assert(
          fc.asyncProperty(anyHistory, fc.constantFrom<0 | 1>(0, 1), (h, which) =>
            using(setup, async (a) => {
              const rules = withId(h);
              const checked = await replay(a.algorithm, a.clock, rules, timed(h.steps));
              const rule = rules[which];
              const key = buildKey(rule, 'a');
              const seen = checked.filter((c) => c.client === 'a').at(-1)?.seen ?? START;
              a.clock.set(seen);
              let denied: Decision | undefined;
              for (let i = 0; i <= t.burst(rule) && denied === undefined; i++) {
                const decision = await a.algorithm.check(key, rule);
                if (!decision.allowed) denied = decision;
              }
              if (denied === undefined) throw new Error('still allowed after a full burst');
              a.clock.advance(denied.resetMs - 1);
              expect(await a.algorithm.check(key, rule)).toMatchObject({
                allowed: false,
                resetMs: 1,
              });
              a.clock.advance(1);
              expect((await a.algorithm.check(key, rule)).allowed).toBe(true);
            }),
          ),
          params,
        );
      },
      opts.timeout,
    );

    it(
      'after any history, an allowed request restores a full burst in exactly resetMs',
      async () => {
        await fc.assert(
          fc.asyncProperty(anyHistory, fc.constantFrom<0 | 1>(0, 1), (h, which) =>
            using(setup, async (a) => {
              const rules = withId(h);
              const checked = await replay(a.algorithm, a.clock, rules, timed(h.steps));
              const rule = rules[which];
              const key = buildKey(rule, 'a');
              const seen = checked.filter((c) => c.client === 'a').at(-1)?.seen ?? START;
              a.clock.set(seen);
              let last = await a.algorithm.check(key, rule);
              if (!last.allowed) {
                a.clock.advance(last.resetMs);
                last = await a.algorithm.check(key, rule);
                expect(last.allowed).toBe(true);
              }
              a.clock.advance(last.resetMs);
              const burst = t.burst(rule);
              for (let i = 0; i < burst; i++) {
                expect(await a.algorithm.check(key, rule)).toMatchObject({
                  allowed: true,
                  remaining: burst - 1 - i,
                });
              }
              expect((await a.algorithm.check(key, rule)).allowed).toBe(false);
            }),
          ),
          params,
        );
      },
      opts.timeout,
    );
  });
}

/**
 * Differential: the algorithm against a reference that decides the same way by other means, on
 * every check of any history. For the Redis scripts: the in-memory token bucket, or a model.
 */
export function describeModelComparison(
  name: string,
  setup: () => AlgorithmUnderTest | Promise<AlgorithmUnderTest>,
  reference: (clock: Clock) => Algorithm & { close?: () => void },
  supportsBurst: boolean,
  opts: PropertyOptions,
): void {
  const arb = history({
    supportsBurst,
    twoRules: true,
    twoClients: true,
    back: true,
    maxSteps: opts.maxSteps,
  });
  it(
    `${name}: gives the reference's answer on every check of any history`,
    async () => {
      await fc.assert(
        fc.asyncProperty(arb, (h) =>
          using(setup, async (a) => {
            const rules = withId(h);
            const steps = timed(h.steps);
            const refClock = new FakeClock();
            const ref = reference(refClock);
            try {
              const got = await replay(a.algorithm, a.clock, rules, steps);
              const want = await replay(ref, refClock, rules, steps);
              expect(got.map((c) => c.decision)).toStrictEqual(want.map((c) => c.decision));
            } finally {
              ref.close?.();
            }
          }),
        ),
        runParameters(opts.numRuns),
      );
    },
    opts.timeout,
  );
}
