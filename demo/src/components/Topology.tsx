// The path a request takes: the load balancer hands it to one of three instances, which all share
// one count in Redis. The connecting lines are drawn from where the boxes actually are, measured
// whenever anything changes size, so they stay attached at any width.
import { useLayoutEffect, useRef, useState } from 'react';
import type { InstanceStats } from '../stats.ts';
import type { Simulation } from '../useSimulation.ts';
import { storeText } from './controls.tsx';
import { DatabaseIcon, ServerIcon, SplitIcon } from './icons.tsx';
import { allowanceText, Pips, type useAllowance } from './Meter.tsx';

interface Wires {
  readonly width: number;
  readonly height: number;
  /** Load balancer to each instance. */
  readonly fanOut: readonly string[];
  /** Each instance to Redis. */
  readonly fanIn: readonly string[];
}

const NONE: Wires = { width: 0, height: 0, fanOut: [], fanIn: [] };

/** A smooth curve from the bottom middle of one box down to the top middle of another. */
function curve(from: DOMRect, to: DOMRect, origin: DOMRect): string {
  const x1 = from.left + from.width / 2 - origin.left;
  const y1 = from.bottom - origin.top;
  const x2 = to.left + to.width / 2 - origin.left;
  const y2 = to.top - origin.top;
  const mid = (y1 + y2) / 2;
  return `M ${String(x1)} ${String(y1)} C ${String(x1)} ${String(mid)}, ${String(x2)} ${String(mid)}, ${String(x2)} ${String(y2)}`;
}

export function Topology({
  sim,
  stats,
  nextInstance,
  allowance,
}: {
  sim: Simulation;
  stats: readonly InstanceStats[];
  nextInstance: number;
  allowance: ReturnType<typeof useAllowance>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const balancer = useRef<HTMLDivElement>(null);
  const redis = useRef<HTMLDivElement>(null);
  const instances = useRef<(HTMLLIElement | null)[]>([]);
  const [wires, setWires] = useState<Wires>(NONE);

  useLayoutEffect(() => {
    const box = container.current;
    if (box === null) return;
    const measure = () => {
      const lb = balancer.current?.getBoundingClientRect();
      const db = redis.current?.getBoundingClientRect();
      const nodes = instances.current.flatMap((el) =>
        el === null ? [] : [el.getBoundingClientRect()],
      );
      if (lb === undefined || db === undefined) return;
      const origin = box.getBoundingClientRect();
      setWires({
        width: origin.width,
        height: origin.height,
        fanOut: nodes.map((n) => curve(lb, n, origin)),
        fanIn: nodes.map((n) => curve(n, db, origin)),
      });
    };
    // A ResizeObserver reports each element once on observe, so this also draws the first time.
    const observer = new ResizeObserver(measure);
    for (const el of [box, balancer.current, redis.current, ...instances.current]) {
      if (el !== null) observer.observe(el);
    }
    return () => {
      observer.disconnect();
    };
  }, []);

  const latest = sim.responses[0];
  // Keyed on the latest request, so the path it took lights up again for each new one.
  const hot = latest === undefined ? undefined : latest.instance - 1;
  const hotKey = latest?.seq ?? 0;

  return (
    <div className="topology" ref={container}>
      <svg
        className="wires"
        width={wires.width}
        height={wires.height}
        viewBox={`0 0 ${String(wires.width)} ${String(wires.height)}`}
        aria-hidden="true"
      >
        {wires.fanOut.map((d, i) => (
          <path
            key={i === hot ? `out-${String(i)}-${String(hotKey)}` : `out-${String(i)}`}
            className="wire"
            data-hot={i === hot}
            d={d}
          />
        ))}
        {wires.fanIn.map((d, i) => (
          <path
            key={i === hot ? `in-${String(i)}-${String(hotKey)}` : `in-${String(i)}`}
            className="wire"
            data-down={sim.redisDown}
            data-hot={i === hot && !sim.redisDown && latest?.source === 'shared'}
            d={d}
          />
        ))}
      </svg>

      <div className="tier">
        <div className="node node-lb" ref={balancer}>
          <span className="node-head">
            <span className="node-icon">
              <SplitIcon size={15} />
            </span>
            <span className="node-label">Load balancer</span>
          </span>
          <span className="node-sub">Round robin · next: instance {nextInstance}</span>
        </div>
      </div>

      <ul className="tier instances" aria-label="Instances">
        {stats.map((s, i) => (
          <li
            key={s.instance}
            ref={(el) => {
              instances.current[i] = el;
            }}
            className="node node-instance"
            data-status={s.last?.status}
            data-next={s.instance === nextInstance}
          >
            <span className="node-head">
              <span className="node-icon">
                <ServerIcon size={15} />
              </span>
              <span className="node-label">Instance {s.instance}</span>
              {s.instance === nextInstance && <span className="next-badge">Next</span>}
            </span>
            <span className="node-body">
              {/* Keyed on the request, so the flash replays for each new answer. */}
              <span key={s.last?.seq ?? 0} className="flash status-chip">
                {s.last === undefined ? '—' : String(s.last.status)}
              </span>
              <span className="counts">
                <span className="ok">{s.allowed} allowed</span>
                <span className="bad">{s.refused} refused</span>
              </span>
            </span>
            <span className="node-sub">{storeText(sim.redisDown)}</span>
          </li>
        ))}
      </ul>

      <div className="tier">
        <div className="node node-redis" data-down={sim.redisDown} ref={redis}>
          <span className="node-head">
            <span className="node-icon">
              <DatabaseIcon size={15} />
            </span>
            <span className="node-label">Redis</span>
            <span className="redis-state">{sim.redisDown ? 'Down' : 'Shared count'}</span>
          </span>
          {sim.redisDown ? (
            <span className="node-sub">
              Unreachable. Each instance falls back to its own memory.
            </span>
          ) : (
            <>
              <Pips allowance={allowance} />
              <span className="node-sub">{allowanceText(allowance)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
