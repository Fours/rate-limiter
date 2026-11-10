// The write-up's charts, drawn as SVG at the width they're shown, so text stays its real size on
// a phone. Two forms cover them all: horizontal bars and lines. Colors are roles from
// writeup.css (validated: blue and orange pass the CVD and contrast checks on white). Every
// chart sits in a Figure with its numbers in a table, so a tooltip is never the only way to a
// value.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export const SERIES_1 = 'var(--series-1)';
export const SERIES_2 = 'var(--series-2)';
export const BASELINE = 'var(--series-base)';

export interface Series {
  readonly name: string;
  readonly color: string;
}

function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width] as const;
}

interface Tip {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly rows: readonly { readonly series: Series; readonly value: string }[];
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (tip === null) return null;
  // Flip to the left of the pointer near the right edge, so it never leaves the chart.
  const left = tip.x > width - 180 ? tip.x - 12 : tip.x + 12;
  return (
    <div
      className="chart-tip"
      style={{
        left,
        top: tip.y,
        transform: tip.x > width - 180 ? 'translateX(-100%)' : undefined,
      }}
      aria-hidden="true"
    >
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map(({ series, value }) => (
        <div className="chart-tip-row" key={series.name}>
          <span className="line-key" style={{ background: series.color }} />
          <strong>{value}</strong>
          <span>{series.name}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({
  series,
  kind,
}: {
  series: readonly Series[];
  kind: 'bar' | 'line' | 'dot';
}) {
  if (series.length < 2) return null;
  return (
    <ul className="chart-legend">
      {series.map((s) => (
        <li key={s.name}>
          <span
            className={kind === 'line' ? 'line-key' : `swatch ${kind}`}
            style={{ background: s.color }}
          />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/** A bar from the baseline at x0 to x1, its data end rounded and its base square. */
function barPath(x0: number, x1: number, y: number, h: number): string {
  const r = Math.min(4, h / 2, Math.max(0, x1 - x0));
  return ['M', x0, y, 'H', x1 - r, 'A', r, r, 0, 0, 1, x1, y + r, 'V', y + h - r]
    .concat(['A', r, r, 0, 0, 1, x1 - r, y + h, 'H', x0, 'Z'])
    .join(' ');
}

export interface BarRow {
  readonly label: string;
  /** One value per series. */
  readonly values: readonly number[];
  /** Drawn in the baseline gray: the no-limiter row. */
  readonly baseline?: boolean;
}

/** Horizontal bars, one band per row and one bar per series, values at the tips. */
export function BarChart({
  rows,
  series,
  format,
  reference,
  label,
}: {
  rows: readonly BarRow[];
  series: readonly Series[];
  format: (n: number) => string;
  reference?: { value: number; label: string };
  /** What the chart shows, for screen readers. */
  label: string;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  // Narrow screens put each label above its bars rather than beside them.
  const stacked = width < 520;
  const labelWidth = stacked ? 0 : 168;
  const bar = series.length > 1 ? 12 : 18;
  const gap = 2;
  const barsHeight = series.length * bar + (series.length - 1) * gap;
  const labelRow = stacked ? 20 : 0;
  const band = labelRow + barsHeight + 14;
  const top = reference === undefined ? 4 : 22;
  const height = top + rows.length * band;
  const valueRoom = 64;
  const plotWidth = Math.max(40, width - labelWidth - valueRoom);
  const max = Math.max(reference?.value ?? 0, ...rows.flatMap((r) => r.values));
  const x = (v: number) => labelWidth + (v / max) * plotWidth;

  return (
    <div className="chart" ref={ref}>
      <Legend series={series} kind="bar" />
      <svg width={width} height={height} role="img" aria-label={label}>
        {rows.map((row, i) => {
          const y0 = top + i * band;
          const show = (e: { clientX: number; clientY: number }) => {
            const box = ref.current?.getBoundingClientRect();
            if (box === undefined) return;
            setTip({
              x: e.clientX - box.left,
              y: e.clientY - box.top,
              title: row.label,
              rows: series.map((s, j) => ({ series: s, value: format(row.values[j] ?? 0) })),
            });
          };
          return (
            <g
              key={row.label}
              className="bar-row"
              onPointerMove={show}
              onPointerLeave={() => {
                setTip(null);
              }}
            >
              <rect className="hit" x={0} y={y0} width={width} height={band} fill="transparent" />
              <text
                className="axis-label"
                x={stacked ? 0 : labelWidth - 10}
                y={stacked ? y0 + 13 : y0 + barsHeight / 2 + 4}
                textAnchor={stacked ? 'start' : 'end'}
              >
                {row.label}
              </text>
              {series.map((s, j) => {
                const v = row.values[j] ?? 0;
                const y = y0 + labelRow + j * (bar + gap);
                return (
                  <g key={s.name}>
                    <path
                      d={barPath(x(0), x(v), y, bar)}
                      fill={row.baseline === true ? BASELINE : s.color}
                    />
                    <text className="value-label" x={x(v) + 6} y={y + bar / 2 + 4}>
                      {format(v)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
        <line
          className="baseline"
          x1={x(0)}
          x2={x(0)}
          y1={top - 4}
          y2={height}
          shapeRendering="crispEdges"
        />
        {reference !== undefined && (
          <g className="reference">
            <line
              x1={x(reference.value)}
              x2={x(reference.value)}
              y1={top - 6}
              y2={height}
              shapeRendering="crispEdges"
            />
            <text x={x(reference.value)} y={11} textAnchor="middle">
              {reference.label}
            </text>
          </g>
        )}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

export interface LineSeries extends Series {
  readonly points: readonly (readonly [number, number])[];
}

export interface Axis {
  readonly ticks: readonly number[];
  readonly format: (n: number) => string;
}

/**
 * Lines over a linear x, or over evenly spaced categories (`categories`), on a linear or log
 * y. A crosshair snaps to the nearest x and reads every series there.
 */
export function LineChart({
  series,
  x: xAxis,
  y: yAxis,
  categories,
  log = false,
  reference,
  markers = false,
  dots = false,
  height = 260,
  label,
  xTitle,
}: {
  series: readonly LineSeries[];
  x: Axis & { readonly min: number; readonly max: number };
  y: Axis & { readonly min: number; readonly max: number };
  /** Evenly spaced x positions for these values, instead of a linear scale. */
  categories?: readonly number[];
  log?: boolean;
  reference?: { value: number; label: string };
  markers?: boolean;
  /**
   * Points only, no lines: for values known only at each point, where a line between two
   * would draw a slope that never happened.
   */
  dots?: boolean;
  height?: number;
  label: string;
  xTitle: string;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const clipId = useId();
  const endLabels = width >= 560;
  const margin = { top: 12, right: endLabels ? 132 : 16, bottom: 40, left: 52 };
  const plotW = Math.max(40, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;

  const x = (v: number) => {
    if (categories !== undefined) {
      const i = categories.indexOf(v);
      return margin.left + (categories.length < 2 ? 0 : (i / (categories.length - 1)) * plotW);
    }
    return margin.left + ((v - xAxis.min) / (xAxis.max - xAxis.min)) * plotW;
  };
  const yNorm = (v: number) =>
    log
      ? (Math.log10(v) - Math.log10(yAxis.min)) / (Math.log10(yAxis.max) - Math.log10(yAxis.min))
      : (v - yAxis.min) / (yAxis.max - yAxis.min);
  const y = (v: number) => margin.top + plotH - yNorm(v) * plotH;

  const xs = [...new Set(series.flatMap((s) => s.points.map(([px]) => px)))].sort((a, b) => a - b);
  const nearest = (px: number) => {
    let best = xs[0] ?? 0;
    for (const v of xs) if (Math.abs(x(v) - px) < Math.abs(x(best) - px)) best = v;
    return best;
  };
  /** Each series' value at an x: its last point at or before it. */
  const valueAt = (s: LineSeries, at: number) => {
    let found: number | undefined;
    for (const [px, py] of s.points) {
      if (px > at) break;
      found = py;
    }
    return found;
  };

  const onMove = (e: { clientX: number; clientY: number }) => {
    const box = ref.current?.getBoundingClientRect();
    if (box === undefined) return;
    const px = e.clientX - box.left;
    const at = nearest(px);
    setHoverX(at);
    setTip({
      x: x(at),
      y: Math.max(margin.top, e.clientY - box.top - 40),
      title: `${xTitle}: ${xAxis.format(at)}`,
      rows: series.flatMap((s) => {
        const v = valueAt(s, at);
        return v === undefined ? [] : [{ series: s, value: yAxis.format(v) }];
      }),
    });
  };

  const path = (s: LineSeries) =>
    s.points.map(([px, py], i) => [i === 0 ? 'M' : 'L', x(px), y(py)].join(' ')).join(' ');

  return (
    <div className="chart" ref={ref}>
      <Legend series={series} kind={dots ? 'dot' : 'line'} />
      <svg width={width} height={height} role="img" aria-label={label}>
        <defs>
          <clipPath id={clipId}>
            <rect x={margin.left} y={margin.top - 4} width={plotW + 4} height={plotH + 8} />
          </clipPath>
        </defs>
        {yAxis.ticks.map((t) => (
          <g key={t}>
            <line
              className="grid"
              x1={margin.left}
              x2={margin.left + plotW}
              y1={y(t)}
              y2={y(t)}
              shapeRendering="crispEdges"
            />
            <text className="tick" x={margin.left - 8} y={y(t) + 4} textAnchor="end">
              {yAxis.format(t)}
            </text>
          </g>
        ))}
        {xAxis.ticks.map((t) => (
          <text key={t} className="tick" x={x(t)} y={margin.top + plotH + 18} textAnchor="middle">
            {xAxis.format(t)}
          </text>
        ))}
        <text className="axis-title" x={margin.left + plotW / 2} y={height - 4} textAnchor="middle">
          {xTitle}
        </text>
        <line
          className="baseline"
          x1={margin.left}
          x2={margin.left + plotW}
          y1={margin.top + plotH}
          y2={margin.top + plotH}
          shapeRendering="crispEdges"
        />
        {reference !== undefined && (
          <g className="reference">
            <line
              x1={margin.left}
              x2={margin.left + plotW}
              y1={y(reference.value)}
              y2={y(reference.value)}
              shapeRendering="crispEdges"
            />
            {/* At the right edge, clear of where the series start. */}
            <text x={margin.left + plotW - 4} y={y(reference.value) - 6} textAnchor="end">
              {reference.label}
            </text>
          </g>
        )}
        <g clipPath={`url(#${clipId})`}>
          {dots
            ? series.map((s) => (
                <g key={s.name} fill={s.color}>
                  {s.points.map(([px, py], i) => (
                    <circle key={i} cx={x(px)} cy={y(py)} r={1.75} />
                  ))}
                </g>
              ))
            : series.map((s) => (
                <path key={s.name} className="series-line" d={path(s)} stroke={s.color} />
              ))}
          {markers &&
            series.flatMap((s) =>
              s.points.map(([px, py]) => (
                <circle
                  key={`${s.name}-${String(px)}`}
                  className="marker"
                  cx={x(px)}
                  cy={y(py)}
                  r={4}
                  fill={s.color}
                />
              )),
            )}
        </g>
        {endLabels &&
          series.map((s) => {
            const last = s.points[s.points.length - 1];
            if (last === undefined) return null;
            return (
              <text
                key={s.name}
                className="end-label"
                x={margin.left + plotW + 10}
                y={y(last[1]) + 4}
              >
                {s.name}
              </text>
            );
          })}
        {hoverX !== null && (
          <line
            className="crosshair"
            x1={x(hoverX)}
            x2={x(hoverX)}
            y1={margin.top}
            y2={margin.top + plotH}
            shapeRendering="crispEdges"
          />
        )}
        <rect
          x={margin.left}
          y={margin.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => {
            setTip(null);
            setHoverX(null);
          }}
        />
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/** A chart with its title, what it shows, its source and its numbers in a table. */
export function Figure({
  title,
  description,
  source,
  table,
  children,
}: {
  title: string;
  description: ReactNode;
  source: ReactNode;
  table: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] };
  children: ReactNode;
}) {
  return (
    <figure className="wu-figure">
      <figcaption>
        <span className="wu-figure-title">{title}</span>
        <span className="wu-figure-desc">{description}</span>
      </figcaption>
      {children}
      <p className="wu-source">{source}</p>
      <details className="wu-numbers">
        <summary>Show the numbers</summary>
        <div className="wu-table-wrap">
          <table>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.join('|')}>
                  {row.map((cell, i) =>
                    i === 0 ? (
                      <th key={i} scope="row">
                        {cell}
                      </th>
                    ) : (
                      <td key={i}>{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
