// Numbers the dashboards show, worked out from the responses. Pure, so they're easy to test.
import type { AlgorithmName } from './redis/scripts.ts';
import type { SimResponse } from './sim/cluster.ts';

export interface InstanceStats {
  readonly instance: number;
  readonly allowed: number;
  readonly refused: number;
  readonly last: SimResponse | undefined;
}

/** Per instance, from newest-first responses. */
export function instanceStats(
  responses: readonly SimResponse[],
  instances: readonly number[],
): InstanceStats[] {
  return instances.map((instance) => {
    const own = responses.filter((r) => r.instance === instance);
    return {
      instance,
      allowed: own.filter((r) => r.status === 200).length,
      refused: own.filter((r) => r.status === 429).length,
      last: own[0],
    };
  });
}

/**
 * Requests allowed in the `windowMs` up to `now`, across every instance: what a limit of "N per
 * window" promises to keep at or below N while the instances share one count.
 */
export function allowedInLast(
  responses: readonly SimResponse[],
  now: number,
  windowMs: number,
): number {
  return inLast(responses, now, windowMs, 200);
}

/** Requests refused in the `windowMs` up to `now`, across every instance. */
export function refusedInLast(
  responses: readonly SimResponse[],
  now: number,
  windowMs: number,
): number {
  return inLast(responses, now, windowMs, 429);
}

function inLast(
  responses: readonly SimResponse[],
  now: number,
  windowMs: number,
  status: 200 | 429,
): number {
  return responses.filter((r) => r.status === status && r.at > now - windowMs && r.at <= now)
    .length;
}

/**
 * Why more than the limit got through in the last window, when it did. A limit of "N per window"
 * is an average for some algorithms, and an outage or a change of algorithm adds requests that
 * never shared one count. Those two come first: they explain the overshoot whatever the algorithm.
 */
export type OverReason = 'fallback' | 'switched' | 'burst' | 'edge' | 'estimate' | 'other';

export function overReason(
  responses: readonly SimResponse[],
  now: number,
  windowMs: number,
  algorithm: AlgorithmName,
): OverReason {
  const recent = responses.filter((r) => r.status === 200 && r.at > now - windowMs && r.at <= now);
  if (recent.some((r) => r.source === 'fallback')) return 'fallback';
  if (recent.some((r) => r.algorithm !== algorithm)) return 'switched';
  switch (algorithm) {
    case 'token-bucket':
      return 'burst';
    case 'fixed-window':
      return 'edge';
    case 'sliding-window-counter':
      return 'estimate';
    default:
      return 'other';
  }
}
