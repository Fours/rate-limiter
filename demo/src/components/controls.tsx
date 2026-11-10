// The dashboard's controls, each a real button, radio or switch with a name, so they work from
// the keyboard and with a screen reader.
import { ALGORITHM_COPY } from '../algorithms.ts';
import { ALGORITHMS, type AlgorithmName } from '../redis/scripts.ts';
import { keyFor, ruleFor, type SimResponse } from '../sim/cluster.ts';
import { RULE, type Simulation } from '../useSimulation.ts';
import { seconds } from './EdgeComparison.tsx';
import { HoldButton } from './HoldButton.tsx';
import { SendIcon } from './icons.tsx';
import { plainOutcome, ResponseDetails, statusText } from './ResponseDetails.tsx';

export const INSTANCES = [1, 2, 3];

export function AlgorithmPicker({
  value,
  onChange,
  onSeeWeakSpot,
}: {
  value: AlgorithmName;
  onChange: (name: AlgorithmName) => void;
  /** When given, choosing the fixed window offers a way into its weak spot. */
  onSeeWeakSpot?: () => void;
}) {
  return (
    <fieldset className="algo-picker" aria-label="Algorithm">
      {ALGORITHMS.map((name) => (
        <label key={name} className="choice" data-checked={value === name}>
          <input
            type="radio"
            name="algorithm"
            value={name}
            checked={value === name}
            onChange={() => {
              onChange(name);
            }}
          />
          <span>
            <strong>{ALGORITHM_COPY[name].name}</strong>
            {value === name && <span className="summary">{ALGORITHM_COPY[name].summary}</span>}
          </span>
        </label>
      ))}
      {value === 'fixed-window' && onSeeWeakSpot !== undefined && (
        <p className="picker-hint">
          It has a weak spot at the edge of each block.{' '}
          <button type="button" onClick={onSeeWeakSpot}>
            See its weak spot
          </button>
        </p>
      )}
    </fieldset>
  );
}

/** One button: a click sends one request, and holding it down keeps sending. */
export function SendButton({ sim, algorithm }: { sim: Simulation; algorithm: AlgorithmName }) {
  return (
    <HoldButton
      disabled={sim.state.kind !== 'ready'}
      onTick={() => {
        void sim.send(algorithm);
      }}
    >
      <SendIcon />
      Send one request
    </HoldButton>
  );
}

export function RedisSwitch({ sim }: { sim: Simulation }) {
  return (
    <label className="redis-switch" data-down={sim.redisDown}>
      <input
        type="checkbox"
        role="switch"
        checked={!sim.redisDown}
        disabled={sim.state.kind !== 'ready'}
        onChange={(e) => {
          sim.setRedisDown(!e.target.checked);
        }}
      />
      <span>Redis is {sim.redisDown ? 'down' : 'up'}</span>
    </label>
  );
}

/** The rule in force, as the library would be configured for it, and where it's counted. */
export function RuleSummary({
  algorithm,
  redisDown,
}: {
  algorithm: AlgorithmName;
  redisDown: boolean;
}) {
  return (
    <section className="rule-card" aria-labelledby="rule-card-heading">
      <h3 id="rule-card-heading">Active rule</h3>
      <dl>
        <dt>Limit</dt>
        <dd>
          {RULE.limit} per {RULE.windowMs / 1000} s
        </dd>
        <dt>Algorithm</dt>
        <dd>{ALGORITHM_COPY[algorithm].name}</dd>
        <dt>Counted in</dt>
        <dd>{redisDown ? 'Each instance' : 'Redis, via Lua'}</dd>
        <dt className="rule-key">Key</dt>
        <dd className="rule-key">
          <code>{keyFor(ruleFor(RULE, algorithm), 'visitor')}</code>
        </dd>
      </dl>
    </section>
  );
}

/** Says each new response out loud for screen readers; nothing on screen. */
export function Announcer({ latest }: { latest: SimResponse | undefined }) {
  return (
    <p className="visually-hidden" aria-live="polite">
      {latest === undefined
        ? ''
        : `Request ${String(latest.seq)}: instance ${String(latest.instance)} answered ${statusText(latest)}.`}
    </p>
  );
}

/** The badge in the app bar: starting, live, or what went wrong. */
export function StartupStatus({ sim }: { sim: Simulation }) {
  if (sim.state.kind === 'failed') {
    return (
      <p className="status-badge" data-state="failed" role="alert">
        <span className="status-dot" aria-hidden="true" />
        Couldn’t start: {sim.state.error}
      </p>
    );
  }
  return (
    <p className="status-badge" data-state={sim.state.kind} role="status">
      <span className="status-dot" aria-hidden="true" />
      {sim.state.kind === 'loading' ? 'Starting…' : 'Live'}
    </p>
  );
}

export function ResponseLog({
  responses,
  startMs,
}: {
  responses: readonly SimResponse[];
  /** Simulated time the dashboard started: each row's time counts from here. */
  startMs: number;
}) {
  if (responses.length === 0) {
    return (
      <div className="log-empty">
        <p className="log-empty-title">No requests yet</p>
        <p className="hint">Send one, and each response shows up here, newest first.</p>
      </div>
    );
  }
  return (
    <ol className="log" aria-label="Responses">
      {responses.map((r) => (
        <li key={r.seq} data-status={r.status} data-source={r.source}>
          <span className="log-line">
            <span className="seq">#{r.seq}</span>{' '}
            <span className="log-who">Instance {r.instance}:</span>{' '}
            <strong className="log-status">{statusText(r)}</strong>{' '}
            <span className="algo">({ALGORITHM_COPY[r.algorithm].name})</span>
            <time className="log-time">{seconds(r.at - startMs)}</time>
          </span>
          <span className="log-outcome">
            {plainOutcome(r)}
            {r.source === 'fallback' && <span className="tag tag-warn">Counted alone</span>}
          </span>
          <ResponseDetails response={r} />
        </li>
      ))}
    </ol>
  );
}

/** Whether instance `n` is counting with the others or alone, in words. */
export function storeText(redisDown: boolean): string {
  return redisDown ? 'Counting on its own' : 'Using the shared count';
}
