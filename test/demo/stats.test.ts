import { describe, expect, it } from 'vitest';
import type { SimResponse } from '../../demo/src/sim/cluster.ts';
import { allowedInLast, instanceStats } from '../../demo/src/stats.ts';

// Only the fields the stats read; the rest of a response doesn't matter to them.
const response = (seq: number, at: number, status: 200 | 429, instance = 1) =>
  ({ seq, at, status, instance }) as SimResponse;

describe('allowedInLast', () => {
  it('counts the allowed requests in the window up to now, not the refused or older ones', () => {
    const responses = [
      response(5, 20_000, 429),
      response(4, 19_000, 200),
      response(3, 15_000, 200),
      response(2, 10_001, 200),
      // Exactly one window ago: in the window before this one.
      response(1, 10_000, 200),
    ];
    expect(allowedInLast(responses, 20_000, 10_000)).toBe(3);
  });

  it('ignores responses from after now, and is 0 with none', () => {
    expect(allowedInLast([response(1, 30_000, 200)], 20_000, 10_000)).toBe(0);
    expect(allowedInLast([], 20_000, 10_000)).toBe(0);
  });
});

describe('instanceStats', () => {
  const responses = [
    response(4, 4, 429, 1),
    response(3, 3, 200, 3),
    response(2, 2, 200, 2),
    response(1, 1, 200, 1),
  ];

  it('counts each instance, with its newest response', () => {
    const [one, two, three] = instanceStats(responses, [1, 2, 3]);
    expect([one?.allowed, one?.refused, one?.last?.seq]).toEqual([1, 1, 4]);
    expect([two?.allowed, two?.refused, two?.last?.seq]).toEqual([1, 0, 2]);
    expect([three?.allowed, three?.refused, three?.last?.seq]).toEqual([1, 0, 3]);
  });
});
