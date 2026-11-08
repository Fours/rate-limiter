import type { Algorithm, Clock, Decision, Rule } from '../../src/types.js';

// Reference models of the Redis algorithms: the same rules as each script, written again in
// TypeScript, so a script is checked against an independent version step for step. In memory and
// with no expiry. The token bucket has none: the in-memory bucket is its reference.

/** The same rules as fixed-window.lua. */
export function fixedWindowModel(clock: Clock): Algorithm {
  const state = new Map<string, { end: number; count: number; last: number }>();
  return {
    check(key: string, rule: Rule): Promise<Decision> {
      const stored = state.get(key);
      const now = Math.max(clock.now(), stored?.last ?? Number.NEGATIVE_INFINITY);
      let end: number;
      let count: number;
      if (stored === undefined || now >= stored.end) {
        end = Math.floor(now / rule.windowMs) * rule.windowMs + rule.windowMs;
        count = 0;
      } else {
        ({ end, count } = stored);
      }
      const allowed = count < rule.limit;
      if (allowed) count++;
      state.set(key, { end, count, last: now });
      return Promise.resolve({
        allowed,
        remaining: Math.max(0, rule.limit - count),
        resetMs: end - now,
      });
    },
  };
}

/** The same rules as sliding-window-log.lua, as a list of times. */
export function slidingWindowLogModel(clock: Clock): Algorithm {
  const state = new Map<string, { times: number[]; last: number }>();
  return {
    check(key: string, rule: Rule): Promise<Decision> {
      const stored = state.get(key) ?? { times: [], last: Number.NEGATIVE_INFINITY };
      const now = Math.max(clock.now(), stored.last);
      const times = stored.times.filter((t) => t > now - rule.windowMs);
      const allowed = times.length < rule.limit;
      if (allowed) times.push(now);
      state.set(key, { times, last: now });
      const oldestToFree = times[times.length - rule.limit] ?? 0;
      return Promise.resolve({
        allowed,
        remaining: Math.max(0, rule.limit - times.length),
        resetMs: allowed ? rule.windowMs : oldestToFree + rule.windowMs - now,
      });
    },
  };
}

/**
 * The same rules as sliding-window-counter.lua. The denied wait is found by searching for the
 * first ms at which a request fits, instead of by the script's formula, so the formula is checked
 * against a searched answer.
 */
export function slidingWindowCounterModel(clock: Clock): Algorithm {
  type State = { start: number; window: number; curr: number; prev: number; last: number };
  const state = new Map<string, State>();
  return {
    check(key: string, rule: Rule): Promise<Decision> {
      const w = rule.windowMs;
      const stored = state.get(key);
      const now = Math.max(clock.now(), stored?.last ?? Number.NEGATIVE_INFINITY);
      let start = Math.floor(now / w) * w;
      let curr = 0;
      let prev = 0;
      if (stored !== undefined) {
        // Windows go on from the stored one's start, whatever its length (0031).
        const k = Math.floor((now - stored.start) / w);
        start = stored.start + k * w;
        if (k === 0) ({ curr, prev } = stored);
        else if (k === 1) prev = stored.curr;
      }
      const fits = (p: number, c: number, e: number) => p * (w - e) + (c + 1) * w <= rule.limit * w;
      const e = now - start;
      const allowed = fits(prev, curr, e);
      if (allowed) curr++;
      state.set(key, { start, window: w, curr, prev, last: now });

      let resetMs = 2 * w - e;
      if (!allowed) {
        // In this window, then as the previous one, then never counted. Within each, a request
        // that fits keeps fitting as the previous share shrinks, so the first ms that fits can be
        // found by bisection: stepping 1 ms at a time takes too long for a window of a day.
        const at =
          firstFrom(e + 1, w, (x) => fits(prev, curr, x)) ??
          firstFrom(w, 2 * w, (x) => fits(curr, 0, x - w)) ??
          2 * w;
        resetMs = at - e;
      }
      const estimate = prev * (w - e) + curr * w;
      const remaining = Math.max(0, Math.floor((rule.limit * w - estimate) / w));
      return Promise.resolve({ allowed, remaining, resetMs });
    },
  };
}

/** The least x in [from, to) where ok(x) holds, given that it keeps holding once it does. */
function firstFrom(from: number, to: number, ok: (x: number) => boolean): number | undefined {
  if (from >= to || !ok(to - 1)) return undefined;
  let [lo, hi] = [from, to - 1];
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The same rules as leaky-bucket.lua, but with the TAT as one exact fraction (a BigInt count of
 * 1/limit ms) instead of whole ms plus a remainder, so the script's carrying is checked
 * independently. A burst b lets a slot be taken (b - 1) * windowMs of those units early.
 */
export function leakyBucketModel(clock: Clock): Algorithm {
  const state = new Map<string, { n: bigint; limit: bigint; window: bigint; last: number }>();
  const floorDiv = (a: bigint, b: bigint) => a / b; // a, b >= 0 here
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  return {
    check(key: string, rule: Rule): Promise<Decision> {
      const limit = BigInt(rule.limit);
      const window = BigInt(rule.windowMs);
      const stored = state.get(key);
      const now = Math.max(clock.now(), stored?.last ?? Number.NEGATIVE_INFINITY);
      const nowN = BigInt(now) * limit;
      let n = nowN;
      if (stored !== undefined) {
        n = stored.n;
        if (stored.limit !== limit || stored.window !== window) {
          n = ceilDiv(n, stored.limit) * limit; // round up to a whole ms
        }
      }
      if (floorDiv(n, limit) < BigInt(now)) n = nowN;

      const tolerance = BigInt((rule.burst ?? 1) - 1) * window;
      const allowed = n - tolerance < BigInt(now + 1) * limit;
      if (allowed) n += window;
      state.set(key, { n, limit, window, last: now });

      const room = BigInt(now + 1) * limit - n + tolerance;
      const remaining = room > 0n ? Number(ceilDiv(room, window)) : 0;
      // Denied: n - tolerance >= (now + 1) * limit > 0, so floorDiv's operands are positive.
      const resetMs = Number(allowed ? ceilDiv(n, limit) : floorDiv(n - tolerance, limit)) - now;
      return Promise.resolve({ allowed, remaining, resetMs });
    },
  };
}
