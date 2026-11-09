import fc from 'fast-check';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScriptRunner, type ScriptRunner } from '../../demo/src/redis/lua.ts';
import { ALGORITHMS, SCRIPT_SOURCES, type AlgorithmName } from '../../demo/src/redis/scripts.ts';
import { StandInRedis, type Dump } from '../../demo/src/redis/stand-in.ts';
import { runParameters } from '../contract/algorithm-properties.js';
import { connectIoredis, uniqueRuleId } from './helpers/redis.js';

/**
 * The demo's stand-in against real Redis (decision 0024): the same generated histories of checks
 * through both, comparing each reply, the key's whole stored state after it, and the expiry the
 * script set. Each check sends the scripts' test-only time override (ARGV[3]), so both sides see
 * the same time.
 *
 * On Redis each check runs in one MULTI that also reads the key back and PERSISTs it, so nothing
 * expires on real time partway through. The stand-in's expiry is off to match; its expiry on
 * simulated time has unit tests in test/demo/stand-in.test.ts.
 *
 * FC_SEED replays a failure, and FC_RUNS searches longer, as in the property tests (0034).
 */

const RUNS_PER_ALGORITHM = 50;
const STEPS = { min: 40, max: 60 };
/** The spec's floor for one full run: about 12,500 checks are expected. */
const MIN_CHECKS = 10_000;

const BUCKETS: ReadonlySet<AlgorithmName> = new Set(['token-bucket', 'leaky-bucket']);

interface RuleArgs {
  readonly limit: number;
  readonly windowMs: number;
  /** Only the two buckets read ARGV[4]. Empty means the rule's default. */
  readonly burst: number | undefined;
}

interface Step {
  /** How time moves before this check. */
  readonly time:
    | { kind: 'same' }
    | { kind: 'ms'; ms: number }
    | { kind: 'paced'; factor: number }
    | { kind: 'windows'; factor: number }
    | { kind: 'edge'; which: 'window' | 'before' | 'after' | 'interval' }
    | { kind: 'back'; ms: number };
  /** A new rule for this key from here on, as when an operator edits it. */
  readonly newRule: RuleArgs | undefined;
  /** Another algorithm checks this key once, as after a switch (0016). */
  readonly other: AlgorithmName | undefined;
}

interface History {
  readonly startMs: number;
  readonly rule: RuleArgs;
  readonly steps: readonly Step[];
}

const ruleArgs = (burst: boolean): fc.Arbitrary<RuleArgs> =>
  fc.record({
    limit: fc.constantFrom(1, 2, 3, 5, 7, 10, 20, 100),
    windowMs: fc.constantFrom(1, 7, 100, 333, 1_000, 1_500, 60_000),
    burst: burst
      ? fc.option(fc.constantFrom(1, 2, 4, 15, 150), { nil: undefined })
      : fc.constant(undefined),
  });

const step = (burst: boolean): fc.Arbitrary<Step> =>
  fc.record({
    time: fc.oneof(
      { weight: 5, arbitrary: fc.constant({ kind: 'same' as const }) },
      {
        weight: 5,
        arbitrary: fc.integer({ min: 1, max: 3 }).map((ms) => ({ kind: 'ms' as const, ms })),
      },
      {
        weight: 7,
        arbitrary: fc
          .double({ min: 0, max: 2, noNaN: true })
          .map((factor) => ({ kind: 'paced' as const, factor })),
      },
      {
        weight: 1,
        arbitrary: fc
          .double({ min: 0, max: 2, noNaN: true })
          .map((factor) => ({ kind: 'windows' as const, factor })),
      },
      {
        weight: 2,
        arbitrary: fc
          .constantFrom('window' as const, 'before' as const, 'after' as const, 'interval' as const)
          .map((which) => ({ kind: 'edge' as const, which })),
      },
      {
        weight: 1,
        arbitrary: fc.integer({ min: 1, max: 50 }).map((ms) => ({ kind: 'back' as const, ms })),
      },
    ),
    newRule: fc.option(ruleArgs(burst), { nil: undefined, freq: 25 }),
    other: fc.option(fc.constantFrom(...ALGORITHMS), { nil: undefined, freq: 30 }),
  });

const history = (alg: AlgorithmName): fc.Arbitrary<History> =>
  fc.record({
    startMs: fc.integer({ min: 1_700_000_000_000, max: 1_700_010_000_000 }),
    rule: ruleArgs(BUCKETS.has(alg)),
    steps: fc.array(step(BUCKETS.has(alg)), { minLength: STEPS.min, maxLength: STEPS.max }),
  });

function advance(now: number, time: Step['time'], rule: RuleArgs): number {
  const interval = Math.ceil(rule.windowMs / rule.limit);
  switch (time.kind) {
    case 'same':
      return now;
    case 'ms':
      return now + time.ms;
    case 'paced':
      return now + Math.round(interval * time.factor);
    case 'windows':
      return now + Math.round(rule.windowMs * time.factor);
    case 'edge':
      return (
        now +
        { window: rule.windowMs, before: rule.windowMs - 1, after: rule.windowMs + 1, interval }[
          time.which
        ]
      );
    case 'back':
      return now - time.ms;
  }
}

type Outcome = { reply: unknown } | { error: string };

let real: Redis;
let stand: StandInRedis;
let runner: ScriptRunner;
let now = 0;
let checks = 0;

beforeAll(async () => {
  real = await connectIoredis();
  stand = new StandInRedis(() => now);
  stand.expiry = false;
  runner = await createScriptRunner(stand);
});

afterAll(async () => {
  runner.close();
  await real.quit();
});

function realDump(type: unknown, hash: unknown, zset: unknown): Dump {
  if (type === 'hash') {
    return {
      type: 'hash',
      value: Object.fromEntries(Object.entries(hash as Record<string, string>).sort()),
    };
  }
  if (type === 'zset') return { type: 'zset', value: zset as string[] };
  return { type: 'none' };
}

/** One check on both sides. Returns what differs, or nothing. */
async function compare(alg: AlgorithmName, key: string, rule: RuleArgs): Promise<string[]> {
  const args = [String(rule.limit), String(rule.windowMs), String(now), String(rule.burst ?? '')];
  // EVAL, not EVALSHA: the source goes over each time, so the script cache plays no part.
  const results = await real
    .multi()
    .eval(SCRIPT_SOURCES[alg], 1, key, ...args)
    .pttl(key)
    .persist(key)
    .type(key)
    .hgetall(key)
    .zrange(key, '0', '-1', 'WITHSCORES')
    .exec();
  if (results === null) throw new Error('MULTI was aborted');
  const [[evalError, evalReply], [, pttl], , [, type], [, hash], [, zset]] = results as [
    [Error | null, unknown],
    [null, number],
    unknown,
    [null, string],
    [unknown, unknown],
    [unknown, unknown],
  ];

  const want: Outcome = evalError === null ? { reply: evalReply } : { error: evalError.message };
  let got: Outcome;
  try {
    got = { reply: runner.run(SCRIPT_SOURCES[alg], [key], args) };
  } catch (err) {
    got = { error: err instanceof Error ? err.message : String(err) };
  }
  const setTtl = stand.lastPexpire.get(key);
  stand.lastPexpire.delete(key);
  checks++;

  const problems: string[] = [];
  // The scripts never fail on valid arguments, so an error on either side is a problem, even on
  // both: two errors would otherwise hide every difference after them.
  if (JSON.stringify(want) !== JSON.stringify(got) || 'error' in want) {
    problems.push(`reply: Redis ${JSON.stringify(want)}, stand-in ${JSON.stringify(got)}`);
  }
  const [wantState, gotState] = [realDump(type, hash, zset), stand.dump(key)];
  if (JSON.stringify(wantState) !== JSON.stringify(gotState)) {
    problems.push(
      `state: Redis ${JSON.stringify(wantState)}, stand-in ${JSON.stringify(gotState)}`,
    );
  }
  if (setTtl !== undefined && setTtl > 0) {
    // PTTL is read a moment after the script ran, so Redis may already be 1 ms lower.
    if (pttl !== setTtl && pttl !== setTtl - 1) {
      problems.push(`expiry: Redis PTTL ${String(pttl)}, stand-in PEXPIRE ${String(setTtl)}`);
    }
  } else if (setTtl !== undefined && pttl !== -2) {
    problems.push(
      `expiry: stand-in PEXPIRE ${String(setTtl)} deletes the key, Redis PTTL ${String(pttl)}`,
    );
  }
  return problems;
}

async function replay(alg: AlgorithmName, h: History): Promise<void> {
  const key = `${uniqueRuleId('demo-parity')}:${alg}`;
  let rule = h.rule;
  now = h.startMs;
  try {
    for (const [i, s] of h.steps.entries()) {
      now = advance(now, s.time, rule);
      rule = s.newRule ?? rule;
      const problems = await compare(s.other ?? alg, key, rule);
      if (problems.length > 0) {
        throw new Error(
          `${alg}, step ${String(i)} (${s.other ?? alg} checking, rule ${JSON.stringify(rule)}, ` +
            `time ${String(now)}):\n  ${problems.join('\n  ')}`,
        );
      }
    }
  } finally {
    await real.del(key);
    stand.clear();
  }
}

describe('the demo stand-in matches Redis', () => {
  it.each(ALGORITHMS)(
    '%s: replies, stored state and expiry',
    async (alg) => {
      await fc.assert(
        fc.asyncProperty(history(alg), (h) => replay(alg, h)),
        runParameters(RUNS_PER_ALGORITHM),
      );
    },
    120_000,
  );

  it(`ran at least ${String(MIN_CHECKS)} checks`, () => {
    // Replaying one seed, or a shorter search, runs fewer on purpose.
    if (process.env.FC_SEED !== undefined || Number(process.env.FC_RUNS ?? 1) < 1) return;
    expect(checks).toBeGreaterThanOrEqual(MIN_CHECKS);
  });
});
