import { useEffect, useState } from 'react';
import type { AlgorithmName } from '../redis/scripts.ts';
import type { Availability } from '../sim/cluster.ts';
import type { Simulation } from '../useSimulation.ts';
import { seconds } from './EdgeComparison.tsx';

/**
 * What the shared count would let through right now under `algorithm`, asked of the shipped
 * script on every redraw without spending anything, so it refills on screen as it does in Redis.
 * Undefined until the first answer, and while Redis is down.
 */
export function useAllowance(sim: Simulation, algorithm: AlgorithmName): Availability | undefined {
  const [allowance, setAllowance] = useState<Availability | undefined>(undefined);
  const { available, now, responses, redisDown } = sim;
  useEffect(() => {
    let current = true;
    void available(algorithm).then((a) => {
      if (current) setAllowance(a);
    });
    return () => {
      current = false;
    };
    // responses and redisDown: so a send or the switch shows at once, not on the next redraw.
  }, [available, algorithm, now, responses, redisDown]);
  return allowance;
}

/** One dot per request that could go through now. */
export function Pips({ allowance }: { allowance: Availability | undefined }) {
  const { available = 0, limit = 0 } = allowance ?? {};
  return (
    <span
      className="pips"
      role="img"
      aria-label={`${String(available)} of ${String(limit)} available now`}
    >
      {Array.from({ length: limit }, (_, i) => (
        <span key={i} className="pip" data-full={i < available} />
      ))}
    </span>
  );
}

/** "4 of 6 available now", or when none is, how long until one frees up. */
export function allowanceText(a: Availability | undefined): string {
  if (a === undefined) return '…';
  if (a.available > 0) return `${String(a.available)} of ${String(a.limit)} available now`;
  return `None left · next frees up in ${seconds(a.nextInMs)}`;
}
