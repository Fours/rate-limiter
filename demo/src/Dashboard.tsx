// The demo's dashboard: controls on the left, the path a request takes in the middle (load
// balancer → three instances → Redis), the log on the right, and every request on a timeline
// across the bottom. The fixed-window comparison opens full screen from the top bar.
import {
  AlgorithmPicker,
  Announcer,
  INSTANCES,
  RedisSwitch,
  ResponseLog,
  SendButtons,
  StartupStatus,
} from './components/controls.tsx';
import { EdgeTeaser } from './components/EdgeView.tsx';
import { InstanceTimeline } from './components/InstanceTimeline.tsx';
import { useAllowance } from './components/Meter.tsx';
import { Topology } from './components/Topology.tsx';
import type { AlgorithmName } from './redis/scripts.ts';
import { allowedInLast, instanceStats } from './stats.ts';
import { RULE, type Simulation } from './useSimulation.ts';
import './dashboard.css';

export function Dashboard({
  sim,
  algorithm,
  setAlgorithm,
  showEdge,
}: {
  sim: Simulation;
  algorithm: AlgorithmName;
  setAlgorithm: (name: AlgorithmName) => void;
  /** Opens the fixed-window view, full screen. */
  showEdge: () => void;
}) {
  const stats = instanceStats(sim.responses, INSTANCES);
  const latest = sim.responses[0];
  const nextInstance = latest === undefined ? 1 : (latest.instance % INSTANCES.length) + 1;
  const allowance = useAllowance(sim, algorithm);
  const inLastWindow = allowedInLast(sim.responses, sim.now, RULE.windowMs);

  return (
    <div className="dashboard">
      <header className="dash-top">
        <div>
          <h1>Rate limiter</h1>
          <p>
            Three servers share one count in Redis, so a visitor gets{' '}
            <strong>
              {RULE.limit} requests every {RULE.windowMs / 1000} seconds
            </strong>{' '}
            in all, not once per server. Running live in your browser, on the package’s own code.
          </p>
        </div>
        <StartupStatus sim={sim} />
        <EdgeTeaser onOpen={showEdge} />
      </header>

      <aside className="dash-side panel" aria-label="Controls">
        <AlgorithmPicker value={algorithm} onChange={setAlgorithm} onSeeWeakSpot={showEdge} />
        <fieldset>
          <legend>Send requests</legend>
          <SendButtons sim={sim} algorithm={algorithm} />
          <p className="hint">Hold with the mouse, a finger, or Space.</p>
        </fieldset>
        <fieldset>
          <legend>Break things</legend>
          <RedisSwitch sim={sim} />
          <p className="hint">
            {sim.redisDown
              ? 'Each server counts alone now: 2 each, about 6 in all.'
              : 'Switch Redis off and watch each server carry on alone.'}
          </p>
        </fieldset>
        <div className="dash-stat" data-over={inLastWindow > RULE.limit}>
          <span className="dash-stat-label">Allowed, last {RULE.windowMs / 1000} s</span>
          <span className="dash-stat-value">
            {inLastWindow}
            <small> / {RULE.limit}</small>
          </span>
          <span className="hint">Let through by all three servers together.</span>
        </div>
      </aside>

      <section className="dash-stage panel" aria-labelledby="dash-stage-heading">
        <h2 id="dash-stage-heading">Where each request goes</h2>
        <Topology sim={sim} stats={stats} nextInstance={nextInstance} allowance={allowance} />
      </section>

      <section className="dash-lanes panel" aria-labelledby="dash-lanes-heading">
        <InstanceTimeline sim={sim} headingId="dash-lanes-heading" label="Instances over time" />
      </section>

      <section className="dash-log panel" aria-labelledby="dash-log-heading">
        <h2 id="dash-log-heading">Responses</h2>
        <div className="scroll">
          <ResponseLog responses={sim.responses} />
        </div>
      </section>

      <Announcer latest={latest} />
    </div>
  );
}
