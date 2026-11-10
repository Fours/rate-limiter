// The fixed-window comparison: its own store, cluster and clock, so bursting across an edge
// never moves the dashboard's time or touches its counts. It starts the first time the view is
// opened and stays up after, keeping its results; its clock only runs while the view is open.
import { useCallback, useRef, useState } from 'react';
import type { Rule } from '../../src/types.ts';
import type { SimResponse } from './sim/cluster.ts';
import { burstAcrossEdge } from './sim/edge-burst.ts';
import { useCluster } from './useCluster.ts';
import { KEEP, RULE } from './useSimulation.ts';

export const EDGE_RULE: Rule = { ...RULE, id: 'edge' };
export const COMPARED = ['fixed-window', 'sliding-window-log'] as const;

export function useEdgeLab(open: boolean) {
  const [started, setStarted] = useState(open);
  if (open && !started) setStarted(true);
  const { state, running, now, startMs, setNow } = useCluster(started, open ? 1 : 0);
  const [compared, setCompared] = useState<SimResponse[]>([]);
  const visitor = useRef(0);

  const sendToBoth = useCallback(async () => {
    const sim = running.current;
    if (sim === undefined) return;
    const pair = await sim.cluster.send(EDGE_RULE, COMPARED, `visitor-${String(visitor.current)}`);
    setCompared((previous) => [...previous, ...pair].slice(-2 * KEEP));
  }, [running]);

  /** A new visitor sends a full limit just before a window edge and another just after. */
  const burst = useCallback(async () => {
    const sim = running.current;
    if (sim === undefined) return;
    visitor.current += 1;
    setCompared([]);
    const pairs = await burstAcrossEdge(
      sim.cluster,
      sim.clock,
      EDGE_RULE,
      COMPARED,
      `visitor-${String(visitor.current)}`,
    );
    setNow(sim.clock.now());
    setCompared(pairs);
  }, [running, setNow]);

  return { state, now, startMs, compared, sendToBoth, burst };
}

export type EdgeLab = ReturnType<typeof useEdgeLab>;
