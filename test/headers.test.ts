import { describe, expect, it } from 'vitest';
import { rateLimitHeaders, retryAfter } from '../src/headers.js';
import type { Decision, Rule } from '../src/types.js';

const rule: Rule = { id: 'global', limit: 10, windowMs: 60_000 };

function decision(resetMs: number, allowed = true, remaining = 3): Decision {
  return { allowed, remaining, resetMs };
}

describe('rateLimitHeaders', () => {
  it('sets exactly the three RateLimit headers, as strings', () => {
    expect(rateLimitHeaders(rule, decision(5_000))).toStrictEqual({
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '3',
      'RateLimit-Reset': '5',
    });
  });

  it('takes the limit from the rule and the remaining count from the decision', () => {
    const headers = rateLimitHeaders({ ...rule, limit: 7 }, decision(0, false, 0));
    expect(headers['RateLimit-Limit']).toBe('7');
    expect(headers['RateLimit-Remaining']).toBe('0');
  });

  it.each([
    [0, '0'],
    [1, '1'],
    [999, '1'],
    [1_000, '1'],
    [1_001, '2'],
    [60_000, '60'],
  ])('rounds resetMs %i up to %s seconds', (resetMs, seconds) => {
    expect(rateLimitHeaders(rule, decision(resetMs))['RateLimit-Reset']).toBe(seconds);
  });
});

describe('retryAfter', () => {
  it.each([
    [1, '1'],
    [999, '1'],
    [1_000, '1'],
    [1_001, '2'],
    [60_000, '60'],
  ])('rounds resetMs %i up to %s seconds', (resetMs, seconds) => {
    expect(retryAfter(decision(resetMs, false, 0))).toBe(seconds);
  });

  it('never says 0, so a denied client does not retry at once', () => {
    expect(retryAfter(decision(0, false, 0))).toBe('1');
  });
});
