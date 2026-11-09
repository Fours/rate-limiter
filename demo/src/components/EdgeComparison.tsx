import { Fragment } from 'react';
import { ALGORITHM_COPY } from '../algorithms.ts';
import type { SimResponse } from '../sim/cluster.ts';
import { maxAllowedInAnyWindow, nextWindowEdge } from '../sim/timeline.ts';
import { COMPARED, EDGE_RULE } from '../useSimulation.ts';

const seconds = (ms: number, digits = 1) => `${(ms / 1000).toFixed(digits)} s`;

interface Row {
  readonly seq: number;
  readonly at: number;
  readonly fixed: SimResponse | undefined;
  readonly log: SimResponse | undefined;
}

function rows(responses: readonly SimResponse[]): Row[] {
  const bySeq = new Map<number, SimResponse[]>();
  for (const r of responses) bySeq.set(r.seq, [...(bySeq.get(r.seq) ?? []), r]);
  return [...bySeq].map(([seq, pair]) => ({
    seq,
    at: pair[0]?.at ?? 0,
    fixed: pair.find((r) => r.algorithm === 'fixed-window'),
    log: pair.find((r) => r.algorithm === 'sliding-window-log'),
  }));
}

function Verdict({ response }: { response: SimResponse | undefined }) {
  if (response === undefined) return <td />;
  return (
    <td data-status={response.status}>{response.status === 200 ? '✓ allowed' : '✕ refused'}</td>
  );
}

export function EdgeComparison({
  responses,
  now,
  startMs,
  ready,
  redisDown,
  onSend,
  onBurst,
}: {
  responses: readonly SimResponse[];
  now: number;
  startMs: number;
  ready: boolean;
  redisDown: boolean;
  onSend: () => void;
  onBurst: () => void;
}) {
  const { limit, windowMs } = EDGE_RULE;
  const edgeIn = nextWindowEdge(now, windowMs) - now;
  const table = rows(responses);

  return (
    <section aria-labelledby="edge-heading">
      <h2 id="edge-heading">Where the fixed window slips</h2>
      <p>
        The fixed window counts in 10-second blocks, so a visitor can send 6 just before a block
        ends and 6 more just after it starts: 12 in about a second, twice the limit. The sliding
        window log looks back over the last 10 seconds from every request, so it never allows more
        than 6. Here both judge exactly the same requests.
      </p>
      <p className="countdown">
        Next block starts in <strong>{seconds(edgeIn)}</strong>
      </p>
      <div className="row">
        <button type="button" onClick={onBurst} disabled={!ready}>
          Burst across the edge
        </button>
        <button type="button" onClick={onSend} disabled={!ready}>
          Send one to both
        </button>
      </div>
      {redisDown && (
        <p className="warning" role="note">
          Redis is down, so each instance answers both from its own token bucket, and the two can’t
          differ. Turn Redis back on to compare them.
        </p>
      )}
      <p className="hint">
        “Burst across the edge” brings in a new visitor and skips ahead to half a second before the
        next block.
      </p>

      <div className="compare-summary">
        {COMPARED.map((name) => {
          const own = responses.filter((r) => r.algorithm === name);
          const most = maxAllowedInAnyWindow(own, windowMs);
          const over = most > limit;
          return (
            <div key={name} className="card" data-over={over} data-testid={`summary-${name}`}>
              <h3>{ALGORITHM_COPY[name].name}</h3>
              <p>
                Most allowed in any 10 seconds: <strong data-testid={`most-${name}`}>{most}</strong>
              </p>
              <p>
                {own.length === 0
                  ? 'No requests yet.'
                  : over
                    ? `Over the limit of ${String(limit)}.`
                    : `Within the limit of ${String(limit)}.`}
              </p>
            </div>
          );
        })}
      </div>

      {table.length > 0 && (
        <table className="compare-table">
          <caption>The same requests, checked by both</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">{ALGORITHM_COPY['fixed-window'].name}</th>
              <th scope="col">{ALGORITHM_COPY['sliding-window-log'].name}</th>
            </tr>
          </thead>
          <tbody>
            {table.map((row, i) => {
              const previous = table[i - 1];
              const crossed =
                previous !== undefined &&
                Math.floor(previous.at / windowMs) !== Math.floor(row.at / windowMs);
              return (
                <Fragment key={row.seq}>
                  {crossed && (
                    <tr className="edge">
                      <td colSpan={3}>
                        New 10-second block at{' '}
                        {seconds(Math.floor(row.at / windowMs) * windowMs - startMs)}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td>{seconds(row.at - startMs, 2)}</td>
                    <Verdict response={row.fixed} />
                    <Verdict response={row.log} />
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
