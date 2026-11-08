import { describe, expect, it } from 'vitest';
import { fillLine } from '../../bench/edges-report.ts';

describe('fillLine', () => {
  it('says how full each side of each burst edge got', () => {
    const fills = [
      { boundary: 20_000, before: 100, afterMs: 156.4 },
      { boundary: 40_000, before: 61, afterMs: undefined },
    ];
    expect(fillLine(fills, 100)).toBe(
      'each burst edge, slowest client: 100 before, 100 after within 156 ms; 61 before, under 100 after',
    );
  });

  it('says so when no burst was found', () => {
    expect(fillLine([], 100)).toBe('no bursts found');
  });
});
