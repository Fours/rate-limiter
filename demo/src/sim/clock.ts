import type { Clock } from '../../../src/types.ts';

/**
 * The demo's time. The stand-in Redis and every instance's fallback read it, so pausing or
 * slowing it slows everything together. It holds whole milliseconds, as the library does, and
 * keeps any fraction it's given until it adds up to one.
 */
export class SimClock implements Clock {
  #ms: number;
  #fraction = 0;

  constructor(startMs: number) {
    if (!Number.isSafeInteger(startMs)) throw new RangeError('startMs must be an integer');
    this.#ms = startMs;
  }

  now(): number {
    return this.#ms;
  }

  /** Moves forward by `ms`, which may be fractional, as a frame's share of real time is. */
  advance(ms: number): void {
    if (!(ms >= 0) || !Number.isFinite(ms)) throw new RangeError('advance needs ms >= 0');
    const total = this.#fraction + ms;
    const whole = Math.floor(total);
    this.#ms += whole;
    this.#fraction = total - whole;
  }

  /** Jumps forward to `ms`. Time never goes back, as Redis TIME doesn't in the demo. */
  jumpTo(ms: number): void {
    if (!Number.isSafeInteger(ms)) throw new RangeError('ms must be an integer');
    if (ms < this.#ms) throw new RangeError('the clock never goes back');
    this.#ms = ms;
    this.#fraction = 0;
  }
}
