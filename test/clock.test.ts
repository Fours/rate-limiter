import { describe, expect, it } from 'vitest';
import { systemClock } from '../src/clock.js';

describe('systemClock', () => {
  it('returns the current wall-clock time as integer epoch ms', () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
