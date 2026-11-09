import type { SimResponse } from './cluster.ts';

/**
 * The most requests allowed in any `windowMs` of time, over `responses`: what a limit of
 * "N per window" promises never to exceed. A fixed window can reach twice N across an edge.
 */
export function maxAllowedInAnyWindow(
  responses: readonly Pick<SimResponse, 'at' | 'status'>[],
  windowMs: number,
): number {
  const times = responses
    .filter((r) => r.status === 200)
    .map((r) => r.at)
    .sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    // A window is [t, t + windowMs): a request exactly windowMs later is in the next one.
    while ((times[end] ?? 0) - (times[start] ?? 0) >= windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** Where the next fixed window starts after `now`: windows are aligned to the epoch. */
export function nextWindowEdge(now: number, windowMs: number): number {
  return (Math.floor(now / windowMs) + 1) * windowMs;
}
