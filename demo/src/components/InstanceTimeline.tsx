// Every request as a dot on its instance's lane over the last 20 seconds, with the fixed window's
// block edges marked. Its heading and legend come with it; the caller gives it a panel.
import { INSTANCES } from './controls.tsx';
import { Lanes, type Lane } from './Lanes.tsx';
import { statusText } from './ResponseDetails.tsx';
import { instanceStats } from '../stats.ts';
import { RULE, type Simulation } from '../useSimulation.ts';

/** How much time it shows. */
export const SHOWN_MS = 20_000;

export function InstanceTimeline({
  sim,
  headingId,
  label,
}: {
  sim: Simulation;
  headingId: string;
  /** Names the list of lanes, which screen readers get in place of the dots. */
  label: string;
}) {
  const lanes: Lane[] = instanceStats(sim.responses, INSTANCES).map((s) => ({
    key: s.instance,
    label: (
      <>
        <strong>Instance {s.instance}</strong>
        <span className="lane-sub">
          {s.allowed} allowed · {s.refused} refused
        </span>
      </>
    ),
    marks: sim.responses
      .filter((r) => r.instance === s.instance)
      .map((r) => ({
        key: `${String(r.seq)}-${r.algorithm}`,
        at: r.at,
        status: r.status,
        fallback: r.source === 'fallback',
        title: `#${String(r.seq)} ${statusText(r)}`,
      })),
  }));

  return (
    <>
      <div className="panel-head">
        <h2 id={headingId}>
          Timeline <span className="panel-meta">Last 20 seconds</span>
        </h2>
        <span className="lane-legend" aria-hidden="true">
          <span className="lane-mark" data-status="200" /> allowed
          <span className="lane-mark" data-status="429" /> refused
          <span className="lane-mark" data-status="200" data-fallback="true" /> counted alone
          <span className="lane-legend-edge" /> block edge
        </span>
      </div>
      <Lanes
        as="ul"
        label={label}
        lanes={lanes}
        from={sim.now - SHOWN_MS}
        to={sim.now}
        windowMs={RULE.windowMs}
        startMs={sim.startMs}
      />
    </>
  );
}
