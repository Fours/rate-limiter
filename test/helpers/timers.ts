import { expect, vi } from 'vitest';

/**
 * Waits, in real time, until exactly one fake timer is pending: a request has reached the
 * limiter and its timeout is set. Not vi.waitFor: with fake timers on, it advances them on every
 * poll, which would fire the timeout before the test could control it. setImmediate isn't faked.
 */
export async function untilTimerPending(): Promise<void> {
  for (let i = 0; i < 10_000 && vi.getTimerCount() === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(vi.getTimerCount()).toBe(1);
}
