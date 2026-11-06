import { mkdtemp, readFile, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyse, loadResults } from '../../bench/analyse.ts';
import {
  chartFor,
  falseDenials,
  maxInWindow,
  median,
  peakPerWindow,
  percentile,
  RESOLUTION_MS,
  runMetrics,
  summariseRuns,
  throughput,
  type RequestRecord,
  type Run,
  type RunMetrics,
} from '../../bench/analysis.ts';

const W = 1_000;
const rule = { limit: 2, windowMs: W };

function rec(t: number, status: number, client = 'a', e2eMs = 10): RequestRecord {
  return { client, t, status, e2eMs };
}

describe('maxInWindow', () => {
  it('is the limit when requests are spread exactly at the limit', () => {
    // 2 per 1000 ms, one every 500 ms: any 1000 ms span holds exactly 2.
    expect(maxInWindow([0, 500, 1000, 1500, 2000, 2500], W)).toBe(2);
  });

  it('catches a 2× burst across a fixed-window boundary', () => {
    // Two allowed just before 1000 and two just after: a fixed window's worst case.
    expect(maxInWindow([990, 995, 1000, 1005], W)).toBe(4);
  });

  it('finds the busiest span even when it starts between grid points', () => {
    // Spans starting on a 1000 ms grid see at most 2; [300, 1300) holds all three.
    const times = [300, 800, 1200];
    expect(maxInWindow(times, W)).toBe(3);
    const onGrid = [0, 1000].map((s) => times.filter((t) => t >= s && t < s + W).length);
    expect(Math.max(...onGrid)).toBe(2);
  });

  it('treats the span as half-open: requests exactly windowMs apart never share one', () => {
    expect(maxInWindow([0, 1000], W)).toBe(1);
    expect(maxInWindow([0, 999], W)).toBe(2);
  });

  it('handles unsorted input, duplicates and nothing at all', () => {
    expect(maxInWindow([1500, 0, 1500, 600], W)).toBe(3);
    expect(maxInWindow([], W)).toBe(0);
  });
});

describe('peakPerWindow', () => {
  it('measures spans RESOLUTION_MS short of the window, the limiter clock’s resolution', () => {
    // A sliding window log rightly allows requests at Redis ms 0 and 1000 with a 1000 ms window;
    // in real time they can land up to 1 ms less than a window apart.
    const atEdge = [rec(0.6, 200), rec(500, 200), rec(999.9, 200)];
    expect(peakPerWindow(atEdge, W).peak).toBe(2);
    const inside = [rec(0, 200), rec(500, 200), rec(997.9, 200)];
    expect(peakPerWindow(inside, W).peak).toBe(3);
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
  const fixture = join(import.meta.dirname, '..', 'fixtures', 'bench', 'results');

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
