/** What a bounded call came to. Never a rejection, so callers branch instead of catching. */
export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'timeout' }
  | { readonly ok: false; readonly reason: 'error'; readonly error: unknown };

/**
 * Passed to Express's error handler when a check times out and the fallback is off, so a caller
 * who fails closed can tell a slow Redis from other errors.
 */
export class RateLimitTimeoutError extends Error {
  override readonly name = 'RateLimitTimeoutError';

  /** @param timeoutMs The timeout the check ran out of, the middleware's `timeoutMs`. */
  constructor(readonly timeoutMs: number) {
    super(`Rate-limit check took longer than ${String(timeoutMs)} ms`);
  }
}

/**
 * Runs `run`, giving it `timeoutMs`. A synchronous throw counts as an error, like a rejection.
 *
 * The call itself can't be cancelled: a timed-out check keeps running inside the Redis client
 * (decision 0018). Its result is dropped, and its rejection is handled here, so a check that
 * fails after its timeout never becomes an unhandledRejection.
 */
export async function withTimeout<T>(
  run: () => T | Promise<T>,
  timeoutMs: number,
): Promise<Settled<T>> {
  let pending: Promise<T>;
  try {
    // Promise.resolve, because a plain JS algorithm may return a value instead of a promise.
    pending = Promise.resolve(run());
  } catch (error) {
    return { ok: false, reason: 'error', error };
  }

  const settled = pending.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, reason: 'error', error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
