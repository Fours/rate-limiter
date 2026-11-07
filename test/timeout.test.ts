import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitTimeoutError, withTimeout } from '../src/timeout.js';

// Only the timer functions withTimeout uses are faked (AGENTS.md: FakeClock still owns Date).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A promise the test settles by hand, standing in for a Redis call. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withTimeout', () => {
  it('returns the value of a call that settles in time, and leaves no timer behind', async () => {
    await expect(withTimeout(() => Promise.resolve(7), 50)).resolves.toStrictEqual({
      ok: true,
      value: 7,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a plain value, as a plain JS algorithm might return', async () => {
    await expect(withTimeout(() => 7, 50)).resolves.toStrictEqual({ ok: true, value: 7 });
  });

  it('times out a call that hangs, exactly at timeoutMs', async () => {
    const call = deferred<number>();
    let result: unknown;
    void withTimeout(() => call.promise, 50).then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(49);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toStrictEqual({ ok: false, reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a rejection at once, with its error, and clears the timer', async () => {
    const failure = new Error('store down');
    await expect(withTimeout(() => Promise.reject(failure), 50)).resolves.toStrictEqual({
      ok: false,
      reason: 'error',
      error: failure,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a synchronous throw as an error, without starting a timer', async () => {
    const failure = new Error('thrown');
    const result = withTimeout(() => {
      throw failure;
    }, 50);
    expect(vi.getTimerCount()).toBe(0);
    await expect(result).resolves.toStrictEqual({ ok: false, reason: 'error', error: failure });
  });

  it('drops a result that arrives after the timeout', async () => {
    const call = deferred<number>();
    const result = withTimeout(() => call.promise, 50);
    await vi.advanceTimersByTimeAsync(50);
    call.resolve(7);
    await expect(result).resolves.toStrictEqual({ ok: false, reason: 'timeout' });
  });

  it('handles a rejection that arrives after the timeout, so it is never unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const call = deferred<number>();
      const result = withTimeout(() => call.promise, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toStrictEqual({ ok: false, reason: 'timeout' });

      call.reject(new Error('late'));
      // unhandledRejection fires after the microtask queue drains, on a later macrotask.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('RateLimitTimeoutError', () => {
  it('names itself and carries the timeout', () => {
    const err = new RateLimitTimeoutError(50);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RateLimitTimeoutError');
    expect(err.timeoutMs).toBe(50);
    expect(err.message).toBe('Rate-limit check took longer than 50 ms');
  });
});
