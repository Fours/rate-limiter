// The demo's dashboard: an app bar, then controls down the left; headline numbers, the path a
// request takes (load balancer → three instances → Redis) and the response log in the middle; and
// every request on a timeline across the bottom. The fixed-window comparison opens full screen.
import {
  AlgorithmPicker,
  Announcer,
  INSTANCES,
  RedisSwitch,
  ResponseLog,
  RuleSummary,
  SendButton,
  StartupStatus,
} from './components/controls.tsx';
import { EdgeTeaser } from './components/EdgeView.tsx';
import { ExternalIcon, GaugeIcon } from './components/icons.tsx';
import { InstanceTimeline } from './components/InstanceTimeline.tsx';
import { Kpis } from './components/Kpis.tsx';
import { useAllowance } from './components/Meter.tsx';
import { Topology } from './components/Topology.tsx';
import type { AlgorithmName } from './redis/scripts.ts';
import { instanceStats } from './stats.ts';
import { RULE, type Simulation } from './useSimulation.ts';
import './dashboard.css';

const NPM_URL = 'https://www.npmjs.com/package/@kylewillett/rate-limiter';
const REPO_URL = 'https://github.com/Fours/rate-limiter';

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

  return (
    <div className="dashboard">
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark">
            <GaugeIcon size={18} />
          </span>
          <span className="brand-name">Rate limiter</span>
          <span className="brand-sep" aria-hidden="true">
            /
          </span>
          <span className="brand-page">Live demo</span>
          <StartupStatus sim={sim} />
        </div>
        <nav className="app-links" aria-label="Project">
          <a href={NPM_URL} target="_blank" rel="noreferrer">
            npm <ExternalIcon size={13} />
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub <ExternalIcon size={13} />
          </a>
        </nav>
      </header>

      <main className="dash-main">
        <div className="page-head">
          <div className="page-title">
            <h1>One limit, shared by three servers</h1>
            <p>
              Each visitor gets{' '}
              <strong>
                {RULE.limit} requests every {RULE.windowMs / 1000} seconds
              </strong>{' '}
              across all three servers, enforced by one shared count in Redis.
            </p>
          </div>
          <EdgeTeaser onOpen={showEdge} />
        </div>

        <div className="dash-grid">
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
            <RuleSummary algorithm={algorithm} redisDown={sim.redisDown} />
          </aside>

          <Kpis sim={sim} algorithm={algorithm} allowance={allowance} />

          <section className="dash-stage panel" aria-labelledby="dash-stage-heading">
            <div className="panel-head">
              <h2 id="dash-stage-heading">Request flow</h2>
              <span className="panel-meta">Load balancer → 3 instances → Redis</span>
            </div>
            <Topology sim={sim} stats={stats} nextInstance={nextInstance} allowance={allowance} />
          </section>

          <section className="dash-log panel" aria-labelledby="dash-log-heading">
            <div className="panel-head">
              <h2 id="dash-log-heading">Responses</h2>
              <span className="panel-meta">Newest first</span>
            </div>
            <div className="scroll">
              <ResponseLog responses={sim.responses} startMs={sim.startMs} />
            </div>
          </section>

          <section className="dash-lanes panel" aria-labelledby="dash-lanes-heading">
            <InstanceTimeline
              sim={sim}
              headingId="dash-lanes-heading"
              label="Instances over time"
            />
          </section>
        </div>
      </main>

      <Announcer latest={latest} />
    </div>
  );
}
