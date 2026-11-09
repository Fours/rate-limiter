import { useState } from 'react';
import { ALGORITHM_COPY } from './algorithms.ts';
import { EdgeComparison } from './components/EdgeComparison.tsx';
import { HoldButton } from './components/HoldButton.tsx';
import { plainOutcome, ResponseDetails, statusText } from './components/ResponseDetails.tsx';
import { ALGORITHMS, type AlgorithmName } from './redis/scripts.ts';
import type { SimResponse } from './sim/cluster.ts';
import { RULE, useSimulation, type Speed } from './useSimulation.ts';

const SPEEDS: { value: Speed; label: string }[] = [
  { value: 1, label: 'Normal' },
  { value: 0.25, label: 'Slow (¼)' },
  { value: 0, label: 'Paused' },
];

const INSTANCES = [1, 2, 3];

export function App() {
  const sim = useSimulation();
  const [algorithm, setAlgorithm] = useState<AlgorithmName>('token-bucket');
  const ready = sim.state.kind === 'ready';
  const latest = sim.responses[0];
  const elapsed = `${((sim.now - sim.startMs) / 1000).toFixed(1)} s`;

  return (
    <main>
      <header>
        <h1>Rate limiter demo</h1>
        <p className="lede">
          A rate limiter stops one visitor from sending a website too many requests at once. Big
          sites run several copies of their server, so the copies need to share one count, or a
          visitor could get the limit once from each.
        </p>
        <p>
          Here, three copies (“instances”) share a count kept in Redis, a fast shared store. Every
          request goes to the next instance in turn. The limit is{' '}
          <strong>
            {RULE.limit} requests every {RULE.windowMs / 1000} seconds
          </strong>
          . Everything runs in your browser, using the package’s own code.
        </p>
      </header>

      {sim.state.kind === 'loading' && <p role="status">Starting…</p>}
      {sim.state.kind === 'failed' && <p role="alert">Couldn’t start: {sim.state.error}</p>}

      <section aria-labelledby="try-heading">
        <h2 id="try-heading">Try it</h2>

        <fieldset className="algorithms">
          <legend>1. Pick how to count</legend>
          {ALGORITHMS.map((name) => (
            <label key={name} className="choice">
              <input
                type="radio"
                name="algorithm"
                value={name}
                checked={algorithm === name}
                onChange={() => {
                  setAlgorithm(name);
                }}
              />
              <span>
                <strong>{ALGORITHM_COPY[name].name}</strong>
                <span className="summary">{ALGORITHM_COPY[name].summary}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>2. Send requests</legend>
          <div className="row">
            <button
              type="button"
              disabled={!ready}
              onClick={() => {
                void sim.send(algorithm);
              }}
            >
              Send one request
            </button>
            <HoldButton
              disabled={!ready}
              onTick={() => {
                void sim.send(algorithm);
              }}
            >
              Hold to send many
            </HoldButton>
          </div>
          <p className="hint">Hold with the mouse, a finger, or Space.</p>
        </fieldset>

        <fieldset>
          <legend>3. Break things</legend>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={!sim.redisDown}
              disabled={!ready}
              onChange={(e) => {
                sim.setRedisDown(!e.target.checked);
              }}
            />
            <span>Redis is {sim.redisDown ? 'down' : 'up'}</span>
          </label>
          <p className="hint">
            {sim.redisDown
              ? 'Each instance now counts on its own, allowing its share: 2 each, so about 6 in all. The shared count is lost until Redis is back.'
              : 'Turn Redis off to see each instance keep going on its own.'}
          </p>
          <div className="row">
            <span id="speed-label">Time:</span>
            <div role="radiogroup" aria-labelledby="speed-label" className="segmented">
              {SPEEDS.map((s) => (
                <label key={s.value}>
                  <input
                    type="radio"
                    name="speed"
                    checked={sim.speed === s.value}
                    onChange={() => {
                      sim.setSpeed(s.value);
                    }}
                  />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
            <span className="clock" aria-label={`Time since start: ${elapsed}`}>
              {elapsed}
            </span>
          </div>
          <button type="button" className="secondary" disabled={!ready} onClick={sim.reset}>
            Start over
          </button>
        </fieldset>

        <h3>The three instances</h3>
        <ul className="instances" aria-label="Instances">
          {INSTANCES.map((n) => (
            <Instance
              key={n}
              n={n}
              last={sim.responses.find((r) => r.instance === n)}
              redisDown={sim.redisDown}
            />
          ))}
        </ul>

        <p className="visually-hidden" aria-live="polite">
          {latest === undefined
            ? ''
            : `Request ${String(latest.seq)}: instance ${String(latest.instance)} answered ${statusText(latest)}.`}
        </p>

        <h3>Responses, newest first</h3>
        {sim.responses.length === 0 ? (
          <p className="hint">Nothing sent yet.</p>
        ) : (
          <ol className="log" aria-label="Responses">
            {sim.responses.map((r) => (
              <li key={r.seq} data-status={r.status} data-source={r.source}>
                <span className="log-line">
                  <span className="seq">#{r.seq}</span> Instance {r.instance}:{' '}
                  <strong>{statusText(r)}</strong>{' '}
                  <span className="algo">({ALGORITHM_COPY[r.algorithm].name})</span>
                </span>
                <span>
                  {plainOutcome(r)}
                  {r.source === 'fallback' && ' Counted by this instance alone.'}
                </span>
                <ResponseDetails response={r} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <EdgeComparison
        responses={sim.compared}
        now={sim.now}
        startMs={sim.startMs}
        ready={ready}
        redisDown={sim.redisDown}
        onSend={() => {
          void sim.sendToBoth();
        }}
        onBurst={() => {
          void sim.burst();
        }}
      />
    </main>
  );
}

function Instance({
  n,
  last,
  redisDown,
}: {
  n: number;
  last: SimResponse | undefined;
  redisDown: boolean;
}) {
  return (
    <li className="card instance" data-status={last?.status}>
      <h4>Instance {n}</h4>
      <p className="store">{redisDown ? 'Counting on its own' : 'Using the shared count'}</p>
      <p>
        {last === undefined
          ? 'No requests yet.'
          : `Last: #${String(last.seq)}, ${last.status === 200 ? 'allowed' : 'refused'}`}
      </p>
    </li>
  );
}
