import type { Clock } from '../../src/types.js';

// 2026-01-01T00:00:00Z. A realistic epoch rather than 0, so code that treats 0 as "unset" fails.
const DEFAULT_START_MS = 1_767_225_600_000;

export class FakeClock implements Clock {
  #nowMs: number;

  constructor(startMs: number = DEFAULT_START_MS) {
    assertIntegerMs(startMs, 'startMs');
    this.#nowMs = startMs;
  }

  now(): number {
    return this.#nowMs;
  }

  /** Moves forward only; use `set` to simulate a clock going backwards. */
  advance(ms: number): void {
    assertIntegerMs(ms, 'ms');
    if (ms < 0) throw new RangeError(`advance(ms) needs ms >= 0, got ${String(ms)}`);
    this.#nowMs += ms;
  }

  set(ms: number): void {
    assertIntegerMs(ms, 'ms');
    this.#nowMs = ms;
  }
}

function assertIntegerMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be an integer number of ms, got ${String(value)}`);
  }
}
