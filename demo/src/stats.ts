// Numbers the dashboards show, worked out from the responses. Pure, so they're easy to test.
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
  return responses.filter((r) => r.status === 200 && r.at > now - windowMs && r.at <= now).length;
}
