import type { Rule } from '../../../src/types.ts';
import type { AlgorithmName } from '../redis/scripts.ts';
import type { SimClock } from './clock.ts';
import type { Cluster, SimResponse } from './cluster.ts';
import { nextWindowEdge } from './timeline.ts';

/** How far before the edge the first burst starts, and after it the second. */
export const BEFORE_EDGE_MS = 500;
export const AFTER_EDGE_MS = 100;
/** The gap between requests in a burst, so they're apart on the timeline. */
export const BURST_GAP_MS = 50;

/**
 * The fixed window's weak spot: a full limit just before a window edge, then another just after.
 * Every request goes to each of `algorithms`, so they're judged on exactly the same traffic. The
 * clock jumps to just before the next edge first, and a new client sends, so earlier requests
 * don't count.
 */
export async function burstAcrossEdge(
  cluster: Cluster,
  clock: SimClock,
  rule: Rule,
  algorithms: readonly AlgorithmName[],
  clientId: string,
): Promise<SimResponse[]> {
  let edge = nextWindowEdge(clock.now(), rule.windowMs);
  // Too close to the edge to fit the first burst before it: use the one after.
  if (edge - clock.now() < BEFORE_EDGE_MS) edge += rule.windowMs;
  const responses: SimResponse[] = [];
  const burst = async (from: number) => {
    clock.jumpTo(Math.max(clock.now(), from));
    for (let i = 0; i < rule.limit; i++) {
      if (i > 0) clock.jumpTo(Math.max(clock.now(), from + i * BURST_GAP_MS));
      responses.push(...(await cluster.send(rule, algorithms, clientId)));
    }
  };
  await burst(edge - BEFORE_EDGE_MS);
  await burst(edge + AFTER_EDGE_MS);
  return responses;
}
