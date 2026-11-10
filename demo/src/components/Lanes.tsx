import type { ReactNode } from 'react';
import './lanes.css';

export interface LaneMark {
  readonly key: string | number;
  readonly at: number;
  readonly status: 200 | 429;
  /** Decided by the instance alone, while Redis was down. */
  readonly fallback?: boolean;
  readonly title: string;
}

export interface Lane {
  readonly key: string | number;
  readonly label: ReactNode;
  readonly marks: readonly LaneMark[];
}

/**
 * Requests as dots along time, one lane per row, from `from` to `to` (ms). Lines mark the fixed
 * window's block edges. Drawn with positioned HTML rather than SVG, so the dots stay round at any
 * width.
 */
export function Lanes({
  lanes,
  from,
  to,
  windowMs,
  startMs,
  label,
  as: Tag = 'div',
}: {
  lanes: readonly Lane[];
  from: number;
  to: number;
  windowMs: number;
  startMs: number;
  /** Names the chart for screen readers, which get each lane's counts instead of dots. */
  label: string;
  as?: 'div' | 'ul';
}) {
  const span = Math.max(1, to - from);
  const x = (t: number) => `${String(((t - from) / span) * 100)}%`;
  const edges: number[] = [];
  for (let t = Math.ceil(from / windowMs) * windowMs; t <= to; t += windowMs) edges.push(t);
  const Row = Tag === 'ul' ? 'li' : 'div';

  return (
    <div className="lanes">
      <Tag className="lane-list" aria-label={label}>
        {lanes.map((lane) => (
          <Row key={lane.key} className="lane">
            <div className="lane-label">{lane.label}</div>
            <div className="lane-track" aria-hidden="true">
              {edges.map((t) => (
                <span key={t} className="lane-edge" style={{ left: x(t) }} />
              ))}
              {lane.marks
                .filter((m) => m.at >= from && m.at <= to)
                .map((m) => (
                  <span
                    key={m.key}
                    className="lane-mark"
                    data-status={m.status}
                    data-fallback={m.fallback === true}
                    style={{ left: x(m.at) }}
                    title={m.title}
                  />
                ))}
            </div>
          </Row>
        ))}
      </Tag>
      <div className="lane-axis" aria-hidden="true">
        <div className="lane-label" />
        <div className="lane-axis-track">
          {edges.map((t) => (
            <span key={t} style={{ left: x(t) }}>
              {String(Math.round((t - startMs) / 1000))} s
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
