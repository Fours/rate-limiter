// The dashboard's controls, each a real button, radio or switch with a name, so they work from
// the keyboard and with a screen reader.
import { ALGORITHM_COPY } from '../algorithms.ts';
import { ALGORITHMS, type AlgorithmName } from '../redis/scripts.ts';
import type { SimResponse } from '../sim/cluster.ts';
import type { Simulation } from '../useSimulation.ts';
import { HoldButton } from './HoldButton.tsx';
import { plainOutcome, ResponseDetails, statusText } from './ResponseDetails.tsx';

export const INSTANCES = [1, 2, 3];

export function AlgorithmPicker({
  value,
  onChange,
  legend = 'How to count',
  onSeeWeakSpot,
}: {
  value: AlgorithmName;
  onChange: (name: AlgorithmName) => void;
  legend?: string;
  /** When given, choosing the fixed window offers a way into its weak spot. */
  onSeeWeakSpot?: () => void;
}) {
  return (
    <fieldset className="algo-picker">      
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
          This one has a weak spot at the edge of each block.{' '}
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

export function StartupStatus({ sim }: { sim: Simulation }) {
  if (sim.state.kind === 'loading') return <p role="status">Starting…</p>;
  if (sim.state.kind === 'failed') return <p role="alert">Couldn’t start: {sim.state.error}</p>;
  return null;
}

export function ResponseLog({ responses }: { responses: readonly SimResponse[] }) {
  if (responses.length === 0) return <p className="hint">Nothing sent yet.</p>;
  return (
    <ol className="log" aria-label="Responses">
      {responses.map((r) => (
        <li key={r.seq} data-status={r.status} data-source={r.source}>
          <span className="log-line">
            <span className="seq">#{r.seq}</span> Instance {r.instance}:{' '}
            <strong>{statusText(r)}</strong>{' '}
            <span className="algo">({ALGORITHM_COPY[r.algorithm].name})</span>
          </span>
          <span className="log-outcome">
            {plainOutcome(r)}
            {r.source === 'fallback' && ' Counted by this instance alone.'}
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
