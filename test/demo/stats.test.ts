import { describe, expect, it } from 'vitest';
import type { SimResponse } from '../../demo/src/sim/cluster.ts';
import { allowedInLast, instanceStats, overReason, refusedInLast } from '../../demo/src/stats.ts';

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

describe('refusedInLast', () => {
  it('counts the refused requests in the window up to now, not the allowed or older ones', () => {
    const responses = [
      response(5, 21_000, 429),
      response(4, 19_000, 429),
      response(3, 15_000, 200),
      response(2, 10_001, 429),
      response(1, 10_000, 429),
    ];
    expect(refusedInLast(responses, 20_000, 10_000)).toBe(2);
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

describe('overReason', () => {
  const sent = (
    at: number,
    status: 200 | 429 = 200,
    extra: Partial<Pick<SimResponse, 'algorithm' | 'source'>> = {},
  ) =>
    ({
      seq: at,
      at,
      status,
      instance: 1,
      algorithm: 'token-bucket',
      source: 'shared',
      ...extra,
    }) as SimResponse;

  it('blames the outage when any allowed request in the window was counted alone', () => {
    const responses = [sent(19_000, 200, { source: 'fallback', algorithm: 'fixed-window' })];
    expect(overReason(responses, 20_000, 10_000, 'token-bucket')).toBe('fallback');
  });

  it('blames a change of algorithm when one in the window came under another', () => {
    const responses = [sent(19_000), sent(18_000, 200, { algorithm: 'fixed-window' })];
    expect(overReason(responses, 20_000, 10_000, 'token-bucket')).toBe('switched');
  });

  it('ignores refused and older requests when looking for those causes', () => {
    const responses = [
      sent(19_000),
      sent(18_000, 429, { source: 'fallback' }),
      sent(17_000, 429, { algorithm: 'fixed-window' }),
      sent(10_000, 200, { source: 'fallback', algorithm: 'fixed-window' }),
    ];
    expect(overReason(responses, 20_000, 10_000, 'token-bucket')).toBe('burst');
  });

  it('otherwise names what lets the algorithm itself go over', () => {
    const only = (algorithm: SimResponse['algorithm']) =>
      overReason([sent(19_000, 200, { algorithm })], 20_000, 10_000, algorithm);
    expect(only('token-bucket')).toBe('burst');
    expect(only('fixed-window')).toBe('edge');
    expect(only('sliding-window-counter')).toBe('estimate');
    expect(only('sliding-window-log')).toBe('other');
    expect(only('leaky-bucket')).toBe('other');
  });
});
