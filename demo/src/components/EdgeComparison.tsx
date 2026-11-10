import { Fragment } from 'react';
import { ALGORITHM_COPY } from '../algorithms.ts';
import type { SimResponse } from '../sim/cluster.ts';
import { maxAllowedInAnyWindow, nextWindowEdge } from '../sim/timeline.ts';
import { COMPARED, EDGE_RULE, type EdgeLab } from '../useEdgeLab.ts';

export const seconds = (ms: number, digits = 1) => `${(ms / 1000).toFixed(digits)} s`;

/** One request in the comparison: when it came, and what each algorithm said. */
export interface CompareRow {
  readonly seq: number;
  readonly at: number;
  readonly fixed: SimResponse | undefined;
  readonly log: SimResponse | undefined;
}

export function compareRows(responses: readonly SimResponse[]): CompareRow[] {
  const bySeq = new Map<number, SimResponse[]>();
  for (const r of responses) bySeq.set(r.seq, [...(bySeq.get(r.seq) ?? []), r]);
  return [...bySeq].map(([seq, pair]) => ({
    seq,
    at: pair[0]?.at ?? 0,
    fixed: pair.find((r) => r.algorithm === 'fixed-window'),
    log: pair.find((r) => r.algorithm === 'sliding-window-log'),
  }));
}

export const EDGE_EXPLAINER =
  'The fixed window counts in 10-second blocks, so a visitor can send 6 just before a block ends and 6 more just after it starts: 12 in about a second, twice the limit. The sliding window log looks back over the last 10 seconds from every request, so it never allows more than 6.';

function Verdict({ response }: { response: SimResponse | undefined }) {
  if (response === undefined) return <td />;
  return (
    <td data-status={response.status}>{response.status === 200 ? '✓ allowed' : '✕ refused'}</td>
  );
}

/** The countdown and the two buttons. */
export function EdgeControls({ lab }: { lab: EdgeLab }) {
  const ready = lab.state.kind === 'ready';
  const edgeIn = nextWindowEdge(lab.now, EDGE_RULE.windowMs) - lab.now;
  return (
    <div className="edge-controls">
      <p className="countdown">
        Next block starts in <strong>{ready ? seconds(edgeIn) : '…'}</strong>
      </p>
      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={() => {
            void lab.burst();
          }}
          disabled={!ready}
        >
          Burst across the edge
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void lab.sendToBoth();
          }}
          disabled={!ready}
        >
          Send one to both
        </button>
      </div>
      <p className="hint">
        “Burst across the edge” brings in a new visitor and skips ahead to half a second before the
        next block.
      </p>
    </div>
  );
}

/** The most each algorithm allowed in any 10 s, against the limit. */
export function EdgeSummary({ responses }: { responses: readonly SimResponse[] }) {
  const { limit, windowMs } = EDGE_RULE;
  return (
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
  );
}

/** Each request in turn, with a line where a new block starts. */
export function EdgeTable({
  responses,
  startMs,
}: {
  responses: readonly SimResponse[];
  startMs: number;
}) {
  const { windowMs } = EDGE_RULE;
  const table = compareRows(responses);
  if (table.length === 0) return null;
  return (
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
  );
}
