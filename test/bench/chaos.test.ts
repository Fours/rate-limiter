import { describe, expect, it } from 'vitest';
import {
  chaosMetrics,
  chaosTable,
  isFailure,
  outageOf,
  peakAround,
  phaseOf,
  phaseStats,
  recovery,
  type ChaosRun,
  type Fault,
  type RequestRecord,
} from '../../bench/analysis.ts';

const W = 10_000;
const outage = { downAt: 20_000, upAt: 40_000 };

/** One record; the defaults are an allowed, primary-decided request from app-1. */
function rec(
  t: number,
  extra: { [K in keyof RequestRecord]?: RequestRecord[K] | undefined } = {},
): RequestRecord {
  const r = {
    client: 'c',
    t,
    status: 200,
    e2eMs: 1,
    instance: 'app-1',
    source: 'primary',
    ...extra,
  };
  // `source: undefined` means no source at all, as for a request nothing decided.
  return Object.fromEntries(
    Object.entries(r).filter(([, v]) => v !== undefined),
  ) as unknown as RequestRecord;
}

/** `n` allowed requests for `client`, `step` ms apart from `from`. */
function burst(client: string, from: number, n: number, step: number, extra = {}): RequestRecord[] {
  return Array.from({ length: n }, (_, i) => rec(from + i * step, { client, ...extra }));
}

describe('outageOf', () => {
  it('pairs a kill with the start after it, and a pause with the unpause', () => {
    const kill: Fault[] = [
      { action: 'start', at: 40_000 },
      { action: 'kill', at: 20_000 },
    ];
    expect(outageOf(kill)).toEqual(outage);
    expect(
      outageOf([
        { action: 'pause', at: 1 },
        { action: 'unpause', at: 2 },
      ]),
    ).toEqual({ downAt: 1, upAt: 2 });
  });

  it('rejects faults that are not one outage', () => {
    const bad: Fault[][] = [
      [],
      [{ action: 'kill', at: 1 }],
      [
        { action: 'kill', at: 1 },
        { action: 'unpause', at: 2 },
      ],
      [
        { action: 'start', at: 1 },
        { action: 'kill', at: 2 },
      ],
      [
        { action: 'kill', at: 1 },
        { action: 'start', at: 2 },
        { action: 'kill', at: 3 },
      ],
    ];
    for (const faults of bad) expect(() => outageOf(faults)).toThrow(/want a kill then a start/);
  });
});

describe('phaseOf', () => {
  it('puts each change in the phase it starts', () => {
    expect(phaseOf(19_999, outage)).toBe('before');
    expect(phaseOf(20_000, outage)).toBe('outage');
    expect(phaseOf(39_999, outage)).toBe('outage');
    expect(phaseOf(40_000, outage)).toBe('after');
  });
});

describe('phaseStats', () => {
  it('counts failures per phase: no response and 5xx, never a 429', () => {
    expect(isFailure(rec(0, { status: 429 }))).toBe(false);
    expect(isFailure(rec(0, { status: 0 }))).toBe(true);
    expect(isFailure(rec(0, { status: 502 }))).toBe(true);

    const stats = phaseStats(
      [
        rec(1_000),
        rec(2_000, { status: 429 }),
        rec(25_000, { status: 0 }),
        rec(26_000, { status: 502 }),
        rec(45_000),
      ],
      outage,
    );
    expect([stats.before.failures, stats.outage.failures, stats.after.failures]).toEqual([0, 2, 0]);
    expect([stats.before.requests, stats.outage.requests, stats.after.requests]).toEqual([2, 2, 1]);
  });

  it('takes the p99 of each phase separately', () => {
    const before = Array.from({ length: 100 }, (_, i) => rec(i, { e2eMs: i + 1, limiterMs: 0.1 }));
    const during = Array.from({ length: 100 }, (_, i) =>
      rec(20_000 + i, { e2eMs: 51 + i, limiterMs: 50 + i / 100 }),
    );
    const stats = phaseStats([...before, ...during], outage);
    expect(stats.before.e2eP99).toBe(99);
    expect(stats.outage.e2eP99).toBe(149);
    expect(stats.outage.limiterP99).toBe(50.98);
    expect(stats.after.e2eP99).toBeUndefined();
  });

  it("gives the fallback's share of decided requests, leaving out ones nothing decided", () => {
    const stats = phaseStats(
      [
        rec(21_000, { source: 'fallback' }),
        rec(22_000, { source: 'fallback' }),
        rec(23_000, { source: 'fallback' }),
        rec(24_000),
        rec(25_000, { status: 0, source: undefined }),
      ],
      outage,
    );
    expect(stats.outage.fallbackShare).toBe(0.75);
    expect(stats.before.fallbackShare).toBeUndefined();
  });
});

describe('peakAround', () => {
  it('finds a known overshoot when Redis goes away: the primary’s 20, then the fallback’s full buckets', () => {
    // 20 allowed by the primary in the second before Redis goes, then 21 by three fallback
    // buckets of 7 just after: 41 in one window spanning the change.
    const records = [
      ...burst('heavy', 19_000, 20, 50),
      ...burst('heavy', 20_000, 21, 50, { source: 'fallback' }),
      // A denial isn't counted.
      rec(21_100, { client: 'heavy', status: 429, source: 'fallback' }),
    ];
    expect(peakAround(records, W, outage.downAt)).toEqual({ peak: 41, client: 'heavy' });
  });

  it('only counts windows that span the change', () => {
    // 30 allowed well before the change, then 5 near it: no span of ~10 s holds both.
    const records = [...burst('early', 1_000, 30, 10), ...burst('early', 19_000, 5, 10)];
    expect(peakAround(records, W, outage.downAt).peak).toBe(5);
    // And 30 just after a change still count, with no request at the change: the span can start
    // at the change itself.
    expect(peakAround(burst('late', 20_005, 30, 10), W, outage.downAt).peak).toBe(30);
  });

  it('keeps spans RESOLUTION_MS short of the window and half-open, as peakPerWindow does', () => {
    // Two requests exactly window − RESOLUTION_MS apart are never in one span.
    const records = [rec(20_000), rec(20_000 + W - 2)];
    expect(peakAround(records, W, 20_000).peak).toBe(1);
    expect(peakAround([rec(20_000), rec(20_000 + W - 3)], W, 20_000).peak).toBe(2);
  });

  it('names the busiest client, and finds nothing in an empty run', () => {
    const records = [...burst('a', 20_000, 3, 10), ...burst('b', 20_000, 4, 10)];
    expect(peakAround(records, W, 20_000)).toEqual({ peak: 4, client: 'b' });
    expect(peakAround([], W, 20_000)).toEqual({ peak: 0, client: undefined });
  });
});

describe('recovery', () => {
  it('times each instance’s first primary decision after Redis is back, and takes the worst', () => {
    const records = [
      // Primary decisions before the outage, and fallback ones after the return, don't count.
      rec(10_000, { instance: 'app-1' }),
      rec(40_050, { instance: 'app-1', source: 'fallback' }),
      rec(40_100, { instance: 'app-1' }),
      rec(41_000, { instance: 'app-2', source: 'fallback' }),
      rec(40_500, { instance: 'app-2' }),
      rec(42_000, { instance: 'app-3' }),
      rec(43_000, { instance: 'app-3' }),
    ];
    expect(recovery(records, outage.upAt)).toEqual({
      byInstance: { 'app-1': 100, 'app-2': 500, 'app-3': 2_000 },
      worstMs: 2_000,
    });
  });

  it('has no worst time while any instance is still on the fallback', () => {
    const records = [
      rec(40_100, { instance: 'app-1' }),
      rec(45_000, { instance: 'app-2', source: 'fallback' }),
    ];
    expect(recovery(records, outage.upAt)).toEqual({
      byInstance: { 'app-1': 100, 'app-2': undefined },
      worstMs: undefined,
    });
  });
});

describe('chaosMetrics and chaosTable', () => {
  const meta = { algorithm: 'token-bucket', scenario: 'chaos', run: 1, limit: 20, windowMs: W };
  const faults: Fault[] = [
    { action: 'kill', at: outage.downAt },
    { action: 'start', at: outage.upAt },
  ];
  const run: ChaosRun = {
    meta,
    faults,
    dropped: 2,
    records: [
      ...burst('heavy', 19_000, 20, 50),
      ...burst('heavy', 20_000, 21, 50, { source: 'fallback' }),
      rec(30_000, { status: 0, source: undefined }),
      ...burst('heavy', 40_000, 4, 10, { source: 'fallback', instance: 'app-2' }),
      ...burst('heavy', 40_300, 20, 10, { instance: 'app-2' }),
      // app-1, which decided everything before, is back first.
      rec(40_200, { client: 'light' }),
    ],
  };

  it('puts the measures together for one run', () => {
    const m = chaosMetrics(run);
    expect(m.peakDown).toBe(41);
    // Coming back: 4 from app-2's fallback, then 20 from an empty Redis.
    expect(m.peakUp).toBe(24);
    expect(m.recoveryMs).toBe(300);
    expect(m.phases.outage.failures).toBe(1);
    expect(m.dropped).toBe(2);
  });

  it('writes a row per algorithm and per run', () => {
    const table = chaosTable('kill', meta, [['token-bucket', [chaosMetrics(run)]]]);
    expect(table).toContain('## chaos: Redis killed');
    expect(table).toContain(
      '| **token-bucket** | 1 | 1.00 / 1.00 / 1.00 | – | 100.0% | 16.0% | 41 (2.05×) | 24 (1.20×) | 300 | 2 |',
    );
    expect(table).toContain('| run 1 | 1 |');
  });

  it('says "never" when a run never got back to the primary', () => {
    const stuck: ChaosRun = {
      ...run,
      records: run.records.map((r) => (r.t >= outage.upAt ? { ...r, source: 'fallback' } : r)),
    };
    const table = chaosTable('pause', meta, [['token-bucket', [chaosMetrics(stuck)]]]);
    expect(table).toContain('## chaos: Redis paused');
    expect(table).toMatch(/\| never \| 2 \|/);
  });
});
