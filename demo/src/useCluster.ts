// Starts a store, a cluster and a clock, and runs the clock from animation frames. The dashboard
// and the fixed-window comparison each have their own, so one never moves the other's time.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { SimClock } from './sim/clock.ts';
import { createCluster, type Cluster } from './sim/cluster.ts';
import { startStore, type DemoStore } from './store.ts';

/** At most this often, in real ms, the page redraws for the clock alone. */
const REDRAW_MS = 100;

export interface Running {
  readonly clock: SimClock;
  readonly store: DemoStore;
  readonly cluster: Cluster;
  /** Simulated time when it started: times on screen count from here. */
  readonly startMs: number;
}

export type ClusterState =
  { kind: 'loading' } | { kind: 'failed'; error: string } | { kind: 'ready' };

/**
 * @param start whether to start yet: the comparison waits until it's first opened, then stays
 *   up, so its results are still there next time.
 * @param speed how fast simulated time runs: 1 is real time, 0 stopped (the comparison's clock
 *   stops while its view is closed).
 */
export function useCluster(
  start: boolean,
  speed: number,
): {
  state: ClusterState;
  running: RefObject<Running | undefined>;
  now: number;
  startMs: number;
  setNow: (ms: number) => void;
} {
  const [state, setState] = useState<ClusterState>({ kind: 'loading' });
  const running = useRef<Running | undefined>(undefined);
  const [now, setNow] = useState(0);
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    if (!start) return;
    let cancelled = false;
    // Starts on a minute, so the 10 s windows, which are aligned to the epoch, fall on round
    // numbers of the times shown.
    const startMs = Math.floor(Date.now() / 60_000) * 60_000;
    const clock = new SimClock(startMs);
    startStore(() => clock.now()).then(
      (store) => {
        if (cancelled) return;
        const cluster = createCluster({
          algorithms: store.algorithms,
          peekAlgorithms: store.peekAlgorithms,
          redis: store.redis,
          clock,
        });
        running.current = { clock, store, cluster, startMs };
        setNow(startMs);
        setState({ kind: 'ready' });
      },
      (err: unknown) => {
        if (!cancelled) setState({ kind: 'failed', error: String(err) });
      },
    );
    return () => {
      cancelled = true;
      running.current?.cluster.close();
      running.current = undefined;
    };
  }, [start]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    let frame = 0;
    let last = performance.now();
    let lastDraw = 0;
    const tick = (t: number) => {
      const sim = running.current;
      if (sim !== undefined) {
        sim.clock.advance(Math.max(0, t - last) * speedRef.current);
        if (t - lastDraw >= REDRAW_MS) {
          lastDraw = t;
          setNow(sim.clock.now());
        }
      }
      last = t;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [state.kind]);

  return { state, running, now, startMs: running.current?.startMs ?? now, setNow };
}
