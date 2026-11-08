import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyse, loadResults } from '../../bench/analyse.ts';
import {
  chartFor,
  cpuAtPeak,
  edgeFill,
  peakSecond,
  secondsOf,
  spreadTable,
  falseDenials,
  maxInWindow,
  median,
  peakPerWindow,
  percentile,
  RESOLUTION_MS,
  redisOps,
  redisTable,
  runMetrics,
  summariseRuns,
  throughput,
  type RequestRecord,
  type Run,
  type RunMetrics,
} from '../../bench/analysis.ts';

const W = 1_000;
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'bench', 'results');
const rule = { limit: 2, windowMs: W };

function rec(t: number, status: number, client = 'a', e2eMs = 10): RequestRecord {
  return { client, t, status, e2eMs };
}

describe('edgeFill', () => {
  const L = 3;
  const B = 20_000; // a burst boundary, with W = 1000 ms windows
  const at = (t: number, status = 200, client = 'a', sentAt = t - 1): RequestRecord => ({
    client,
    t,
    sentAt,
    status,
    e2eMs: t - sentAt,
  });
  // A burst of L just before B and L just after: what the edges scenario aims for.
  const aimed = (client: string, lateBy = 0): RequestRecord[] => [
    ...[0, 1, 2].map((i) => at(B - 400 + i + lateBy, 200, client)),
    ...[0, 1, 2].map((i) => at(B + 50 + i + lateBy, 200, client)),
  ];

  it('finds a full window either side of a burst that landed where it was aimed', () => {
    expect(edgeFill(aimed('a'), W, L)).toEqual([{ boundary: B, before: L, afterMs: 52 }]);
  });

  it('reports the slowest client on each side', () => {
    // b's bursts arrived 399 ms late: 2 of its first L landed on or after the boundary, so its
    // first window holds 1, and its L-th allowed request in the next one came at B + 449.
    const records = [...aimed('a'), ...aimed('b', 399)];
    expect(edgeFill(records, W, L)).toEqual([{ boundary: B, before: 1, afterMs: 449 }]);
  });

  it('counts only allowed requests, by arrival time', () => {
    const records = [
      ...aimed('a'),
      at(B - 300, 429),
      // Sent before the boundary, arrived after it: the next window's first.
      at(B + 5, 200, 'a', B - 10),
    ];
    expect(edgeFill(records, W, L)).toEqual([{ boundary: B, before: L, afterMs: 51 }]);
  });

  it('says when a client never got the limit after the boundary', () => {
    const records = [
      ...aimed('a'),
      ...[0, 1, 2, 3].map((i) => at(B - 300 + i, 200, 'b')),
      at(B + 60, 200, 'b'),
    ];
    expect(edgeFill(records, W, L)).toEqual([{ boundary: B, before: L, afterMs: undefined }]);
  });

  it('ignores boundaries with only a trickle, and lists burst boundaries in order', () => {
    const records = [
      ...aimed('a').map((r) => ({ ...r, t: r.t + 2 * W, sentAt: (r.sentAt ?? 0) + 2 * W })),
      at(B - 500),
      at(B + 500), // one each side of B: a trickle, not a burst
      at(B - 30 * W + 1),
      ...aimed('a').map((r) => ({ ...r, t: r.t - 2 * W, sentAt: (r.sentAt ?? 0) - 2 * W })),
    ];
    expect(edgeFill(records, W, L).map((f) => f.boundary)).toEqual([B - 2 * W, B + 2 * W]);
  });
});

describe('maxInWindow', () => {
  const at0 = (times: readonly number[]) => times.map((t) => ({ t, slack: 0 }));

  it('is the limit when requests are spread exactly at the limit', () => {
    // 2 per 1000 ms, one every 500 ms: any 1000 ms span holds exactly 2.
    expect(maxInWindow(at0([0, 500, 1000, 1500, 2000, 2500]), W)).toBe(2);
  });

  it('catches a 2× burst across a fixed-window boundary', () => {
    // Two allowed just before 1000 and two just after: a fixed window's worst case.
    expect(maxInWindow(at0([990, 995, 1000, 1005]), W)).toBe(4);
  });

  it('finds the busiest span even when it starts between grid points', () => {
    // Spans starting on a 1000 ms grid see at most 2; [300, 1300) holds all three.
    const times = [300, 800, 1200];
    expect(maxInWindow(at0(times), W)).toBe(3);
    const onGrid = [0, 1000].map((s) => times.filter((t) => t >= s && t < s + W).length);
    expect(Math.max(...onGrid)).toBe(2);
  });

  it('treats the span as half-open: requests exactly windowMs apart never share one', () => {
    expect(maxInWindow(at0([0, 1000]), W)).toBe(1);
    expect(maxInWindow(at0([0, 999]), W)).toBe(2);
  });

  it('counts a request only if it was decided before the span ends, even at its latest', () => {
    // The third arrived 990 ms after the first, but may have been decided up to 15 ms later.
    expect(maxInWindow([...at0([0, 500]), { t: 990, slack: 15 }], W)).toBe(2);
    expect(maxInWindow([...at0([0, 500]), { t: 990, slack: 9 }], W)).toBe(3);
    // The first request's own slack doesn't matter: the span starts when it arrived.
    expect(maxInWindow([{ t: 0, slack: 500 }, ...at0([500, 999])], W)).toBe(3);
  });

  it('checks each request near the end, not just the last one', () => {
    // A slow request before a fast one: the slow one can't be counted, the fast one can.
    expect(maxInWindow([...at0([0]), { t: 980, slack: 30 }, ...at0([985])], W)).toBe(2);
  });

  it('handles unsorted input, duplicates and nothing at all', () => {
    expect(maxInWindow(at0([1500, 0, 1500, 600]), W)).toBe(3);
    expect(maxInWindow(at0([]), W)).toBe(0);
  });
});

describe('peakPerWindow', () => {
  it('gives each request at least RESOLUTION_MS of slack, the limiter clock’s resolution', () => {
    // A sliding window log rightly allows requests at Redis ms 0 and 1000 with a 1000 ms window;
    // in real time they can land up to 1 ms less than a window apart.
    const atEdge = [rec(0.6, 200), rec(500, 200), rec(999.9, 200)];
    expect(peakPerWindow(atEdge, W).peak).toBe(2);
    const inside = [rec(0, 200), rec(500, 200), rec(997.9, 200)];
    expect(peakPerWindow(inside, W).peak).toBe(3);
  });

  it('gives a request the limiter took long over that much more slack', () => {
    // The third arrived 990 ms after the first, but the limiter spent 9.5 ms on it, so Redis
    // may have decided it at 1000: a window after the first. Not a certain overshoot.
    const slow = [rec(0, 200), rec(500, 200), { ...rec(990, 200), limiterMs: 9.5 }];
    expect(peakPerWindow(slow, W).peak).toBe(2);
    const fast = [rec(0, 200), rec(500, 200), { ...rec(990, 200), limiterMs: 8.9 }];
    expect(peakPerWindow(fast, W).peak).toBe(3);
  });

  it('counts only allowed requests, per client, and names the busiest client', () => {
    const records = [
      rec(0, 200, 'a'),
      rec(10, 429, 'a'),
      rec(20, 429, 'a'),
      rec(0, 200, 'b'),
      rec(5, 200, 'b'),
      rec(6, 200, 'c'),
    ];
    expect(peakPerWindow(records, W)).toEqual({ peak: 2, client: 'b' });
  });
});

describe('falseDenials', () => {
  it('finds none when the limit is respected exactly', () => {
    // 2 allowed, then denials while those 2 are still inside the trailing window.
    const records = [rec(0, 200), rec(100, 200), rec(200, 429), rec(999, 429)];
    expect(falseDenials(records, rule)).toBe(0);
  });

  it('counts a denial made while the trailing window had room', () => {
    // By 1002 the request from 0 is more than W + RESOLUTION_MS old, so only 1 is in the window.
    const records = [rec(0, 200), rec(100, 200), rec(1003, 429), rec(1099, 429), rec(1100, 429)];
    expect(falseDenials(records, rule)).toBe(3);
  });

  it('gives a denial within RESOLUTION_MS of the window edge the benefit of the doubt', () => {
    // The limiter's clock is whole ms, and t is taken a little before it decides, so a denial
    // less than 2 ms past the edge may be the limiter correctly counting the old request.
    const records = [rec(0, 200), rec(100, 200), rec(1000, 429), rec(1001, 429), rec(1001.9, 429)];
    expect(RESOLUTION_MS).toBe(2);
    expect(falseDenials(records, rule)).toBe(0);
  });

  it('gives an allowed request the limiter took long over that much more benefit of the doubt', () => {
    // The request at 100 took the limiter 20.5 ms, so it may have been decided at 120: still in
    // the window of a denial at 1110, but certainly not of one at 1121.
    const slow = { ...rec(100, 200), limiterMs: 20.5 };
    expect(falseDenials([rec(0, 200), slow, rec(1110, 200), rec(1115, 429)], rule)).toBe(0);
    expect(falseDenials([rec(0, 200), slow, rec(1110, 200), rec(1121, 429)], rule)).toBe(1);
  });

  it('keeps clients apart', () => {
    const records = [rec(0, 200, 'a'), rec(1, 200, 'a'), rec(2, 429, 'b')];
    expect(falseDenials(records, rule)).toBe(1);
  });

  it('ignores statuses other than 200 and 429', () => {
    expect(falseDenials([rec(0, 500), rec(1, 429)], rule)).toBe(1);
  });
});

describe('percentile (nearest rank)', () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it('gives p50 = 50 and p99 = 99 for 1 to 100', () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it('returns a real sample, never an interpolated value', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 99)).toBe(40);
  });

  it('sorts its input and handles a single sample', () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([7], 99)).toBe(7);
  });

  it('rejects no samples and out-of-range percentiles', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe('median', () => {
  it('takes the middle of three, whatever the order', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it('averages the middle two of an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('rejects no values', () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('throughput', () => {
  const second = (start: number, n: number, e2eMs = 10, status = 200) =>
    Array.from({ length: n }, (_, i) => ({ ...rec(start + i, status), e2eMs }));

  it('is the busiest second that met the SLO', () => {
    expect(throughput([...second(0, 3), ...second(1_000, 5), ...second(2_000, 4)])).toBe(5);
  });

  it('skips a second whose p99 reached 50 ms, and one with an error', () => {
    const slow = second(1_000, 5, 50);
    const failing = [...second(2_000, 5), rec(2_900, 503)];
    expect(throughput([...second(0, 3), ...slow, ...failing])).toBe(3);
  });

  it('counts 429s as healthy: the limiter working is not an error', () => {
    expect(throughput(second(0, 4, 10, 429))).toBe(4);
  });
});

describe('summariseRuns', () => {
  const base: RunMetrics = {
    requests: 6,
    limiterP50: 1,
    limiterP99: 2,
    e2eP50: 10,
    e2eP99: 20,
    throughputRps: 100,
    peakPerWindow: 2,
    falseDenialRate: 0,
  };

  it('takes the median of each metric separately', () => {
    const runs = [
      { ...base, e2eP50: 30, peakPerWindow: 5 },
      { ...base, e2eP50: 10, peakPerWindow: 3 },
      { ...base, e2eP50: 20, peakPerWindow: 4 },
    ];
    const s = summariseRuns('x', runs);
    expect(s).toMatchObject({ runs: 3, e2eP50: 20, peakPerWindow: 4 });
  });

  it('leaves limiter times out when no run has them (ALGORITHM=none)', () => {
    const s = summariseRuns('none', [{ ...base, limiterP50: undefined, limiterP99: undefined }]);
    expect(s.limiterP50).toBeUndefined();
    expect(s.limiterP99).toBeUndefined();
  });
});

describe('chartFor', () => {
  it('uses the run with the median peak, and its busiest client', () => {
    const meta = { algorithm: 'x', scenario: 's', limit: 2, windowMs: W };
    const runs: Run[] = [
      { meta: { ...meta, run: 1 }, records: [rec(0, 200), rec(1, 200), rec(2, 200), rec(3, 200)] },
      {
        meta: { ...meta, run: 2 },
        records: [rec(0, 200, 'q'), rec(10, 200, 'q'), rec(5, 200, 'r')],
      },
      { meta: { ...meta, run: 3 }, records: [rec(0, 200)] },
    ];
    const chart = chartFor(runs);
    expect(chart).toMatchObject({ run: 2, peakPerWindow: 2, client: 'q' });
    expect(chart.series).toEqual([
      { t: 0, allowed: 1 },
      { t: 10, allowed: 2 },
    ]);
  });

  it('counts back from when each request may have been decided, at its latest', () => {
    // The last arrived 995 ms after the first, but the limiter spent 7.2 ms on it, so the first
    // may already have left its window when it was decided.
    const meta = { algorithm: 'x', scenario: 's', run: 1, limit: 2, windowMs: W };
    const records = [rec(0, 200), rec(500, 200), { ...rec(995, 200), limiterMs: 7.2 }];
    expect(chartFor([{ meta, records }]).series.map((p) => p.allowed)).toEqual([1, 2, 2]);
  });
});

describe('runMetrics', () => {
  it('rejects a run with no records', () => {
    const meta = { algorithm: 'x', scenario: 's', run: 1, ...rule };
    expect(() => runMetrics({ meta, records: [] })).toThrow(/x run 1 has no records/);
  });
});

describe('analyse a results directory', () => {
  // A hand-made fixture: fixed-window has three runs, and each cell's median comes from a
  // different run (e2e p50 from run 2, e2e p99 and peak from run 3, limiter p99 from run 1).
  // Every expected value below was worked out by hand before the code ran.
  const fixture = FIXTURE;

  it('builds the summary table from the medians of each algorithm’s runs', async () => {
    const { summary } = analyse(await loadResults(fixture));
    const rows = summary
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'));
    expect(rows.slice(1)).toEqual([
      '| none | – | – | 6.00 | 7.00 | 3 | 3 (1.50× limit) | 0.0% |',
      '| fixed-window | 1.00 | 3.00 | 21.00 | 40.00 | 3 | 3 (1.50× limit) | 0.0% |',
    ]);
    expect(summary).toContain('Rule: 2 per 1000 ms per client.');
    expect(summary).toBe(await readFile(join(fixture, 'summary.md'), 'utf8'));
  });

  it('builds chart data from the median-peak run', async () => {
    const { chart } = analyse(await loadResults(fixture));
    expect(chart.algorithms.map((a) => [a.algorithm, a.run, a.client, a.peakPerWindow])).toEqual([
      ['none', 1, 'c', 3],
      ['fixed-window', 3, 'a', 3],
    ]);
    expect(chart.algorithms[1]?.series).toEqual([
      { t: 0, allowed: 1 },
      { t: 490, allowed: 2 },
      { t: 500, allowed: 3 },
      { t: 1200, allowed: 3 },
    ]);
    const saved: unknown = JSON.parse(await readFile(join(fixture, 'chart.json'), 'utf8'));
    expect(saved).toEqual(chart);
  });

  it('refuses to mix runs with different rules in one table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-'));
    try {
      await cp(fixture, dir, { recursive: true });
      const metaPath = join(dir, 'none', 'run-1', 'meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
      await writeFile(metaPath, JSON.stringify({ ...meta, limit: 3 }));
      await expect(loadResults(dir)).rejects.toThrow(/different scenario or rule/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('names the file and line of a bad record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-'));
    try {
      await cp(fixture, dir, { recursive: true });
      await writeFile(join(dir, 'none', 'run-1', 'requests.jsonl'), '{"client":"c"}\nnot json\n');
      await expect(loadResults(dir)).rejects.toThrow(/requests\.jsonl line 2: not valid JSON/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('per-second totals (the ramp)', () => {
  const second = (start: number, n: number, e2eMs: number, status = 200) =>
    Array.from({ length: n }, (_, i) => ({ ...rec(start + i, status), e2eMs }));
  const records = [
    ...second(0, 3, 10),
    ...second(1_000, 5, 60),
    ...second(2_000, 4, 10),
    rec(2_500, 503),
  ];

  it('sums each second and marks the healthy ones', () => {
    expect(secondsOf(records)).toEqual([
      { second: 0, count: 3, healthy: true, p99: 10 },
      { second: 1, count: 5, healthy: true, p99: 60 },
      { second: 2, count: 5, healthy: false, p99: 10 },
    ]);
  });

  it("skip a second in which k6 dropped iterations: that's the load generator falling behind", () => {
    const seconds = [
      { second: 0, count: 30, healthy: true, p99: 5, dropped: 1 },
      { second: 1, count: 20, healthy: true, p99: 5, dropped: 0 },
      { second: 2, count: 25, healthy: true, p99: 5 },
    ];
    expect(peakSecond(seconds)?.second).toBe(2);
  });

  it('give exactly the throughput the raw records give', () => {
    expect(peakSecond(secondsOf(records))?.count).toBe(throughput(records));
    expect(throughput(records)).toBe(3);
  });

  it('stand in for the records when a run kept only them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-'));
    try {
      const run = join(dir, 'token-bucket', 'run-1');
      await cp(join(FIXTURE, 'none', 'run-1'), run, { recursive: true });
      await writeFile(
        join(run, 'meta.json'),
        JSON.stringify({ algorithm: 'token-bucket', scenario: 'ramp', run: 1, ...rule }),
      );
      await writeFile(
        join(run, 'seconds.jsonl'),
        secondsOf(records)
          .map((x) => JSON.stringify(x))
          .join('\n'),
      );
      const { summary, chart } = analyse(await loadResults(dir));
      // From the totals: 13 requests and a throughput of 3, not the 3 records in requests.jsonl.
      expect(summary).toContain('| token-bucket | – | – | – | – | 3 | – | – |');
      expect(chart.algorithms).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('cpuAtPeak', () => {
  it('takes each container’s highest CPU within a second either side of the peak second', () => {
    const meta = { algorithm: 'x', scenario: 'ramp', run: 1, ...rule };
    const seconds = [
      { second: 10, count: 50, healthy: true, p99: 5 },
      { second: 11, count: 90, healthy: true, p99: 5 },
      { second: 12, count: 120, healthy: true, p99: 80 },
    ];
    const cpu = [
      { at: 9_999, name: 'app-1', cpu: 99 },
      { at: 10_000, name: 'app-1', cpu: 40 },
      { at: 10_500, name: 'app-1', cpu: 80 },
      { at: 11_500, name: 'app-1', cpu: 70 },
      { at: 12_999, name: 'app-1', cpu: 75 },
      { at: 13_000, name: 'app-1', cpu: 98 },
      { at: 11_200, name: 'lb', cpu: 30 },
    ];
    expect(cpuAtPeak({ meta, records: [], seconds, cpu })).toEqual(
      new Map([
        ['app-1', 80],
        ['lb', 30],
      ]),
    );
  });

  it('is undefined without samples', () => {
    const meta = { algorithm: 'x', scenario: 'ramp', run: 1, ...rule };
    expect(cpuAtPeak({ meta, records: [rec(0, 200)] })).toBeUndefined();
  });
});

describe('spreadTable', () => {
  it('shows the lowest and highest of each metric across runs', async () => {
    const results = await loadResults(FIXTURE);
    const metrics = [...results.algorithms].map(([a, runs]) => [a, runs.map(runMetrics)] as const);
    const rows = spreadTable('edges', metrics)
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| ---'))
      .slice(1);
    // Worked out by hand from the fixture: fixed-window's limiter p99s are 3, 4 and 1; its
    // end-to-end p99s 15, 60 and 40; its peaks 4, 2 and 3; its false denials 0, 0 and 1 in 6.
    expect(rows).toEqual([
      '| none | 1 | – | 7.00–7.00 | 3–3 | 3–3 | 0.0%–0.0% |',
      '| fixed-window | 3 | 1.00–4.00 | 15.00–60.00 | 3–3 | 2–4 | 0.0%–16.7% |',
    ]);
  });
});

describe('compressed records', () => {
  it('load the same as plain ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-'));
    try {
      await cp(FIXTURE, dir, { recursive: true });
      const file = join(dir, 'fixed-window', 'run-2', 'requests.jsonl');
      await writeFile(`${file}.gz`, gzipSync(await readFile(file)));
      await rm(file);
      expect(analyse(await loadResults(dir))).toEqual(analyse(await loadResults(FIXTURE)));
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('Redis operations', () => {
  const meta = { algorithm: 'token-bucket', scenario: 'steady', run: 1, ...rule };
  // 4 requests over 2 s (t from 0 to 2,000 ms), and 8 calls between two commands.
  const records = [rec(0, 200), rec(500, 200), rec(1_000, 429), rec(2_000, 200)];

  it('gives round trips per request and per second, and all commands per request', () => {
    expect(
      redisOps({ meta, records, redisCalls: { evalsha: 6, eval: 2, hget: 4, 'script|load': 0 } }),
    ).toEqual({ roundTripsPerRequest: 2, roundTripsPerSecond: 4, commandsPerRequest: 3 });
  });

  it("doesn't count the commands scripts run inside Redis as round trips", () => {
    expect(
      redisOps({ meta, records, redisCalls: { evalsha: 4, hset: 4, time: 4, pexpire: 4 } }),
    ).toMatchObject({ roundTripsPerRequest: 1, commandsPerRequest: 4 });
  });

  it('copes with a 15,000 req/s run, too many records to spread into Math.max', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => rec(i * 5, 200));
    expect(redisOps({ meta, records: many, redisCalls: { evalsha: 200_000 } })).toMatchObject({
      roundTripsPerRequest: 1,
    });
  });

  it('uses per-second totals when a run kept only those', () => {
    const seconds = [
      { second: 0, count: 300, healthy: true, p99: 1 },
      { second: 1, count: 100, healthy: true, p99: 1 },
    ];
    expect(redisOps({ meta, records: [], seconds, redisCalls: { evalsha: 400 } })).toEqual({
      roundTripsPerRequest: 1,
      roundTripsPerSecond: 200,
      commandsPerRequest: 1,
    });
  });

  it("is undefined for a run that didn't record Redis calls", () => {
    expect(redisOps({ meta, records })).toBeUndefined();
  });

  it('tabulates the median of runs, and nothing when no run recorded calls', () => {
    const run = (evalsha: number) => ({ meta, records, redisCalls: { evalsha } });
    const table = redisTable([
      ['token-bucket', [run(4), run(8), run(400)]],
      ['none', [{ meta: { ...meta, algorithm: 'none' }, records, redisCalls: {} }]],
    ]);
    expect(table).toContain('| none | 0.000 | 0 | 0.00 | – |');
    expect(table).toContain('| token-bucket | 2.000 | 4 | 2.00 | `evalsha` |');
    expect(table.indexOf('| none')).toBeLessThan(table.indexOf('| token-bucket'));
    expect(redisTable([['token-bucket', [{ meta, records }]]])).toBe('');
  });
});

describe('loading Redis calls', () => {
  it("reads each run's redis-calls.json into a Redis table under the summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-'));
    try {
      await cp(FIXTURE, dir, { recursive: true });
      for (const run of ['run-1', 'run-2', 'run-3']) {
        await writeFile(join(dir, 'fixed-window', run, 'redis-calls.json'), '{"evalsha":7}\n');
      }
      const { summary } = analyse(await loadResults(dir));
      const plain = analyse(await loadResults(FIXTURE)).summary;
      expect(summary.startsWith(plain)).toBe(true);
      expect(summary).toMatch(
        /### Redis operations[\s\S]*\| fixed-window \| [\d.]+ \| [\d,]+ \| [\d.]+ \| `evalsha` \|/,
      );
      expect(plain).not.toContain('Redis operations');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
