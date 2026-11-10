// The demo's dashboard: controls on the left, the path a request takes in the middle (load
// balancer → three instances → Redis), the log on the right, and every request on a timeline
// across the bottom. The fixed-window comparison opens full screen from the top bar.
import {
  AlgorithmPicker,
  Announcer,
  INSTANCES,
  RedisSwitch,
  ResponseLog,
  SendButton,
  StartupStatus,
} from './components/controls.tsx';
import { EdgeTeaser } from './components/EdgeView.tsx';
import { InstanceTimeline } from './components/InstanceTimeline.tsx';
import { useAllowance } from './components/Meter.tsx';
import { Topology } from './components/Topology.tsx';
import type { AlgorithmName } from './redis/scripts.ts';
import { allowedInLast, instanceStats, overReason, type OverReason } from './stats.ts';
import { RULE, type Simulation } from './useSimulation.ts';
import './dashboard.css';

/** Under the count, when more than 6 got through: why that isn't the limiter failing. */
const OVER_TEXT: Record<OverReason, string> = {
  fallback:
    'Over 6, because some came while Redis was down, when each server counted alone. 6 holds again once Redis is back.',
  switched:
    'Over 6, because some came under another algorithm, which keeps its own count. Switching starts a fresh 6.',
  burst:
    'Over 6, as the token bucket allows: 6 at once, then one every 1.7 s, so up to 11 in 10 s. 6 per 10 s is its average.',
  edge: 'Over 6: the fixed window counts in blocks, so up to 12 can get through across a block edge.',
  estimate:
    'Over 6: the sliding window counter estimates the last 10 s, so it can let a little more through than the log would.',
  other: 'Over 6 in these 10 s, counting every request the three servers let through.',
};

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
        <h2>Controls</h2>
        <AlgorithmPicker value={algorithm} onChange={setAlgorithm} onSeeWeakSpot={showEdge} />
        <fieldset>
          
          <SendButton sim={sim} algorithm={algorithm} />
          <p className="hint">Hold to send many.</p>
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
          <span className="hint">
            {inLastWindow > RULE.limit
              ? OVER_TEXT[overReason(sim.responses, sim.now, RULE.windowMs, algorithm)]
              : 'Let through by all three servers together.'}
          </span>
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
