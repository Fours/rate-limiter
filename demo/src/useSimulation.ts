// The dashboard's simulation: three instances, the visitor's requests, and Redis up or down, in
// real time. The simulation itself (sim/) knows nothing of React.
import { useCallback, useState } from 'react';
import type { Rule } from '../../src/types.ts';
import type { AlgorithmName } from './redis/scripts.ts';
import type { SimResponse } from './sim/cluster.ts';
import { useCluster } from './useCluster.ts';

/** 6 requests per 10 s: small enough to hit by hand, and 2 per instance during an outage. */
export const RULE: Rule = { id: 'demo', limit: 6, windowMs: 10_000 };

/** How many responses the log keeps. */
export const KEEP = 40;

export function useSimulation() {
  const { state, running, now, startMs } = useCluster(true, 1);
  const [responses, setResponses] = useState<SimResponse[]>([]);
  const [redisDown, setRedisDownState] = useState(false);

  const send = useCallback(
    async (algorithm: AlgorithmName) => {
      const sim = running.current;
      if (sim === undefined) return;
      const [response] = await sim.cluster.send(RULE, [algorithm]);
      if (response === undefined) return;
      setResponses((previous) => [response, ...previous].slice(0, KEEP));
    },
    [running],
  );

  const setRedisDown = useCallback(
    (down: boolean) => {
      running.current?.cluster.setRedisDown(down);
      setRedisDownState(down);
    },
    [running],
  );

  /** What the shared count would allow now, under `algorithm`, without spending any. */
  const available = useCallback(
    async (algorithm: AlgorithmName) => running.current?.cluster.available(RULE, algorithm),
    [running],
  );

  return {
    state,
    available,
    responses,
    redisDown,
    now,
    startMs,
    send,
    setRedisDown,
  };
}

export type Simulation = ReturnType<typeof useSimulation>;
