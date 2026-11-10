import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DATA_DIR,
  SOURCES,
  lead,
  loadWriteupData,
  parseSummary,
  percent,
} from '../../demo/build/writeup-data.ts';

// The write-up's charts are built from docs/decisions/data/ (spec T7). These read the committed
// data, so a moved or renamed results directory fails here, not on the live site.

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of just the files the write-up reads, to break one at a time. */
function copyOfSources(): string {
  const dir = mkdtempSync(join(tmpdir(), 'writeup-data-'));
  copies.push(dir);
  for (const source of Object.values(SOURCES)) {
    cpSync(join(DATA_DIR, source), join(dir, source), { recursive: true });
  }
  return dir;
}

describe('loadWriteupData', () => {
  const data = loadWriteupData();

  it('reads the numbers the decision records quote', () => {
    // 0008's edges table: the fixed window's 2× and the log's exact limit.
    const peak = (a: string) => data.edges.rows.find((r) => r.algorithm === a)?.peak;
    expect(data.edges).toMatchObject({ limit: 100, windowMs: 10_000 });
    expect(peak('fixed-window')).toBe(200);
    expect(peak('sliding-window-log')).toBe(100);
    expect(peak('sliding-window-counter')).toBe(105);
    expect(data.edges.rows.find((r) => r.algorithm === 'sliding-window-counter')).toMatchObject({
      falseDenials: 0.146,
    });

    expect(data.steady.rows.find((r) => r.algorithm === 'none')).toEqual({
      algorithm: 'none',
      limiterP50: null,
      limiterP99: null,
      e2eP50: 0.57,
      e2eP99: 1.49,
    });
    expect(data.ramp.find((r) => r.algorithm === 'sliding-window-log')).toEqual({
      algorithm: 'sliding-window-log',
      throughput: 39_977,
      redisCpu: 78,
    });
    expect(
      data.memory.find((r) => r.algorithm === 'sliding-window-log' && r.limit === 1000),
    ).toEqual({
      algorithm: 'sliding-window-log',
      limit: 1000,
      bytes: 102_944,
      encoding: 'skiplist',
    });
    expect(data.baseline).toEqual([
      { rate: 500, limiterP50: 0.18, limiterP99: 0.72, roundTripsPerRequest: 1 },
      { rate: 15_000, limiterP50: 0.11, limiterP99: 0.85, roundTripsPerRequest: 1 },
    ]);
    expect(data.metrics.without.limiterP99).toBe(0.94);
    expect(data.metrics.with.limiterP99).toBe(0.97);
  });

  it('takes each chaos median, not its runs', () => {
    expect(data.chaos.limit).toBe(20);
    expect(data.chaos.killed.map((r) => r.algorithm)).toEqual([
      'token-bucket',
      'leaky-bucket',
      'fixed-window',
      'sliding-window-log',
      'sliding-window-counter',
    ]);
    expect(data.chaos.killed[0]).toEqual({
      algorithm: 'token-bucket',
      failed: 0,
      p99: [1.85, 1.58, 1.77],
      fallbackShare: 1,
      peakGoing: 41,
      peakComing: 42,
      recoveryMs: 2173,
    });
    expect(data.chaos.paused.find((r) => r.algorithm === 'token-bucket')?.p99).toEqual([
      1.89, 53.24, 1.89,
    ]);
  });

  it("keeps every algorithm's edges series, in order", () => {
    expect(data.edges.series.map((s) => s.algorithm)).toEqual(
      data.edges.rows.map((r) => r.algorithm),
    );
    const fixed = data.edges.series.find((s) => s.algorithm === 'fixed-window');
    expect(Math.max(...(fixed?.points.map(([, n]) => n) ?? []))).toBe(200);
  });

  it.each(Object.entries(SOURCES))('fails, naming the file, without %s', (_name, source) => {
    const dir = copyOfSources();
    rmSync(join(dir, source));
    expect(() => loadWriteupData(dir)).toThrow(join(dir, source));
  });

  it('fails on a summary whose table lost a column', () => {
    const dir = copyOfSources();
    const path = join(dir, SOURCES.edges);
    writeFileSync(
      path,
      '## edges\n\nRule: 100 per 10000 ms per client.\n\n| Algorithm | Throughput (req/s) |\n| --- | --- |\n| token-bucket | 1050 |\n',
    );
    expect(() => loadWriteupData(dir)).toThrow(
      `${path}, "## edges" has no "Peak per window" column`,
    );
  });

  it('fails on JSON that is not JSON', () => {
    const dir = copyOfSources();
    writeFileSync(join(dir, SOURCES.memory), '{');
    expect(() => loadWriteupData(dir)).toThrow(`${join(dir, SOURCES.memory)} isn't valid JSON`);
  });

  it('reads only from dated results directories', () => {
    // Every source sits in a dated results directory, as docs/decisions/README.md asks.
    for (const source of Object.values(SOURCES)) {
      expect(dirname(source)).toMatch(/^\d{4}-.+-\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('parseSummary', () => {
  const md = [
    '## steady',
    '',
    'Rule: 100 per 60000 ms per client.',
    '',
    '| Algorithm | Limiter p99 (ms) |',
    '| --- | --- |',
    '| **token-bucket** | 0.73 |',
    '| run 1 | 0.70 |',
    '',
    '### Redis operations',
    '',
    '| Algorithm | Round trips per request |',
    '| --- | --- |',
    '| token-bucket | 1.000 |',
  ].join('\n');

  it('reads the rule, the first table and a table under a heading', () => {
    const s = parseSummary(md, 'x.md').section('steady');
    expect(s.rule).toEqual({ limit: 100, windowMs: 60_000 });
    expect(s.table().rows.map((r) => r.get('Limiter p99 (ms)'))).toEqual(['0.73']);
    expect(s.table('Redis operations').row('token-bucket').get('Round trips per request')).toBe(
      '1.000',
    );
  });

  it('names what is missing', () => {
    const doc = parseSummary(md, 'x.md');
    expect(() => doc.section('edges')).toThrow('x.md has no "## edges" section');
    expect(() => doc.section('steady').table('CPU')).toThrow(
      'x.md, "## steady" has no table under "### CPU"',
    );
    expect(() => doc.section('steady').table().row('leaky-bucket')).toThrow(
      'has no "leaky-bucket" row',
    );
  });
});

describe('cells', () => {
  it('reads the leading number', () => {
    expect(lead('1,050')).toBe(1050);
    expect(lead('154 (1.54× limit)')).toBe(154);
    expect(lead('78%')).toBe(78);
    expect(percent('14.6%')).toBeCloseTo(0.146);
    expect(() => lead('–')).toThrow('"–" isn\'t a number');
  });
});
