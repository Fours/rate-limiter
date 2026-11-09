import { useEffect, useState } from 'react';
import type { Decision, Rule } from '../../src/types.ts';
import { startStore, type DemoStore } from './store.ts';

// T5's page: just enough to prove the shipped Lua runs in the browser. T6 replaces it.
const RULE: Rule = { id: 'demo', limit: 5, windowMs: 10_000 };

type Status =
  { kind: 'loading' } | { kind: 'ready'; store: DemoStore } | { kind: 'failed'; error: string };

export function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [decisions, setDecisions] = useState<Decision[]>([]);

  useEffect(() => {
    let cancelled = false;
    startStore(() => Date.now()).then(
      (store) => {
        if (!cancelled) setStatus({ kind: 'ready', store });
      },
      (err: unknown) => {
        if (!cancelled) setStatus({ kind: 'failed', error: String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const check = async (store: DemoStore) => {
    const decision = await store.algorithms['token-bucket'].check('rl:demo:visitor', RULE);
    setDecisions((previous) => [decision, ...previous]);
  };

  return (
    <main>
      <h1>Rate limiter demo</h1>
      <p>
        A token bucket allows {RULE.limit} requests every {RULE.windowMs / 1000} seconds. Each check
        runs the package&apos;s own Lua script, in your browser.
      </p>
      {status.kind === 'loading' && <p role="status">Starting…</p>}
      {status.kind === 'failed' && <p role="alert">Couldn&apos;t start: {status.error}</p>}
      {status.kind === 'ready' && (
        <button type="button" onClick={() => void check(status.store)}>
          Run a check
        </button>
      )}
      <ol aria-label="Decisions">
        {decisions.map((d, i) => (
          <li key={decisions.length - i} data-allowed={d.allowed}>
            {d.allowed ? 'Allowed' : 'Limited'}: {d.remaining} left, resets in{' '}
            {Math.ceil(d.resetMs / 1000)} s
          </li>
        ))}
      </ol>
    </main>
  );
}
