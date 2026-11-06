import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/types.js';
import { FakeClock } from './fake-clock.js';

describe('FakeClock', () => {
  it('starts at 2026-01-01T00:00:00Z by default', () => {
    expect(new FakeClock().now()).toBe(Date.UTC(2026, 0, 1));
  });

  it('starts at a custom time', () => {
    expect(new FakeClock(5_000).now()).toBe(5_000);
  });

  it('rejects a non-integer start', () => {
    expect(() => new FakeClock(1.5)).toThrow(RangeError);
  });

  it('accumulates advances', () => {
    const clock = new FakeClock(1_000);
    clock.advance(250);
    clock.advance(750);
    expect(clock.now()).toBe(2_000);
  });

  it('treats advance(0) as a no-op', () => {
    const clock = new FakeClock(1_000);
    clock.advance(0);
    expect(clock.now()).toBe(1_000);
  });

  it('rejects negative and fractional advances without changing time', () => {
    const clock = new FakeClock(1_000);
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
    expect(() => {
      clock.advance(0.5);
    }).toThrow(RangeError);
    expect(() => {
      clock.advance(Number.NaN);
    }).toThrow(RangeError);
    expect(clock.now()).toBe(1_000);
  });

  it('sets time forwards and backwards', () => {
    const clock = new FakeClock(1_000);
    clock.set(9_000);
    expect(clock.now()).toBe(9_000);
    clock.set(500);
    expect(clock.now()).toBe(500);
  });

  it('rejects a fractional set without changing time', () => {
    const clock = new FakeClock(1_000);
    expect(() => {
      clock.set(2.5);
    }).toThrow(RangeError);
    expect(clock.now()).toBe(1_000);
  });

  it('can be used wherever a Clock is expected', () => {
    const fake = new FakeClock(42);
    const clock: Clock = fake;
    fake.advance(8);
    expect(clock.now()).toBe(50);
  });
});
