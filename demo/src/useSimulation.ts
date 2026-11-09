// Connects the simulation to React: starts the store, runs simulated time from animation frames,
// and keeps the responses. The simulation itself (sim/) knows nothing of React.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Rule } from '../../src/types.ts';
import type { AlgorithmName } from './redis/scripts.ts';
import { SimClock } from './sim/clock.ts';
import { createCluster, type Cluster, type SimResponse } from './sim/cluster.ts';
import { burstAcrossEdge } from './sim/edge-burst.ts';
import { startStore, type DemoStore } from './store.ts';

/** 6 requests per 10 s: small enough to hit by hand, and 2 per instance during an outage. */
export const RULE: Rule = { id: 'demo', limit: 6, windowMs: 10_000 };
export const EDGE_RULE: Rule = { ...RULE, id: 'edge' };
export const COMPARED = ['fixed-window', 'sliding-window-log'] as const;

export type Speed = 1 | 0.25 | 0;

/** How many responses each list keeps. */
const KEEP = 40;
/** At most this often, in real ms, the page redraws for the clock alone. */
const REDRAW_MS = 100;

interface Running {
  readonly clock: SimClock;
  readonly store: DemoStore;
  readonly cluster: Cluster;
  /** Simulated time when the page started: times on screen count from here. */
  readonly startMs: number;
}

export type SimulationState =
  { kind: 'loading' } | { kind: 'failed'; error: string } | { kind: 'ready' };

export function useSimulation() {
  const [state, setState] = useState<SimulationState>({ kind: 'loading' });
  const running = useRef<Running | undefined>(undefined);
  const [responses, setResponses] = useState<SimResponse[]>([]);
  const [compared, setCompared] = useState<SimResponse[]>([]);
  const [redisDown, setRedisDownState] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [now, setNow] = useState(0);
  const speedRef = useRef<Speed>(1);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  // Bumped by reset, so a response to a request sent before it is dropped.
  const epoch = useRef(0);
  const edgeClient = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Starts on a minute, so the 10 s windows, which are aligned to the epoch, fall on round
    // numbers of the times shown.
    const startMs = Math.floor(Date.now() / 60_000) * 60_000;
    const clock = new SimClock(startMs);
    startStore(() => clock.now()).then(
      (store) => {
        if (cancelled) return;
        const cluster = createCluster({ algorithms: store.algorithms, redis: store.redis, clock });
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
  }, []);

  // Simulated time runs from animation frames, at the chosen speed.
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

  const send = useCallback(async (algorithm: AlgorithmName) => {
    const sim = running.current;
    if (sim === undefined) return;
    const at = epoch.current;
    const [response] = await sim.cluster.send(RULE, [algorithm]);
    if (response === undefined || at !== epoch.current) return;
    setResponses((previous) => [response, ...previous].slice(0, KEEP));
  }, []);

  const sendToBoth = useCallback(async () => {
    const sim = running.current;
    if (sim === undefined) return;
    const at = epoch.current;
    const pair = await sim.cluster.send(
      EDGE_RULE,
      COMPARED,
      `visitor-${String(edgeClient.current)}`,
    );
    if (at !== epoch.current) return;
    setCompared((previous) => [...previous, ...pair].slice(-2 * KEEP));
  }, []);

  /** A new visitor sends a full limit just before a window edge and another just after. */
  const burst = useCallback(async () => {
    const sim = running.current;
    if (sim === undefined) return;
    const at = epoch.current;
    edgeClient.current += 1;
    setCompared([]);
    const pairs = await burstAcrossEdge(
      sim.cluster,
      sim.clock,
      EDGE_RULE,
      COMPARED,
      `visitor-${String(edgeClient.current)}`,
    );
    if (at !== epoch.current) return;
    setNow(sim.clock.now());
    setCompared(pairs);
  }, []);

  const setRedisDown = useCallback((down: boolean) => {
    running.current?.cluster.setRedisDown(down);
    setRedisDownState(down);
  }, []);

  const reset = useCallback(() => {
    const sim = running.current;
    if (sim === undefined) return;
    epoch.current += 1;
    sim.cluster.setRedisDown(false);
    sim.store.redis.clear();
    sim.cluster.reset();
    setRedisDownState(false);
    setResponses([]);
    setCompared([]);
  }, []);

  return {
    state,
    responses,
    compared,
    redisDown,
    speed,
    setSpeed,
    now,
    startMs: running.current?.startMs ?? now,
    send,
    sendToBoth,
    burst,
    setRedisDown,
    reset,
  };
}
