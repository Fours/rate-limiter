// The row of headline numbers above the diagram: what got through, what the shared count has
// left, what was refused, and whether Redis is there to share it.
import type { ReactNode } from 'react';
import type { Availability } from '../sim/cluster.ts';
import { allowedInLast, overReason, refusedInLast, type OverReason } from '../stats.ts';
import type { AlgorithmName } from '../redis/scripts.ts';
import { RULE, type Simulation } from '../useSimulation.ts';
import { seconds } from './EdgeComparison.tsx';

/** Under the count, when more than 6 got through: why that isn't the limiter failing. */
const OVER_TEXT: Record<OverReason, string> = {
  fallback: 'Some came while Redis was down, when each server counted alone.',
  switched: 'Some came under another algorithm, which keeps its own count.',
  burst: 'The token bucket allows it: 6 at once, then 1 every 1.7 s. 6 per 10 s is its average.',
  edge: 'The fixed window counts in blocks, so up to 12 can pass across a block edge.',
  estimate: 'The sliding window counter estimates the window, so it can let a little more through.',
  other: 'Counting every request the three servers let through.',
};

function Kpi({
  label,
  tone,
  children,
  foot,
}: {
  label: string;
  /** Colours the value: over the limit, refused, healthy or down. */
  tone?: 'bad' | 'ok' | undefined;
  children: ReactNode;
  foot: ReactNode;
}) {
  return (
    <div className="kpi" data-tone={tone}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{children}</span>
      <span className="kpi-foot">{foot}</span>
    </div>
  );
}

/** One bar per request the shared count would let through now. */
function Meter({ allowance }: { allowance: Availability | undefined }) {
  const { available = 0, limit = RULE.limit } = allowance ?? {};
  return (
    <span className="kpi-meter" aria-hidden="true">
      {Array.from({ length: limit }, (_, i) => (
        <span key={i} data-full={i < available} />
      ))}
    </span>
  );
}

/** Under the shared count: out of how many, or when the next one frees up. */
function shareText(a: Availability | undefined): string {
  if (a === undefined) return 'Asking Redis…';
  if (a.available > 0) return `of ${String(a.limit)} available to the next request.`;
  return `Next one frees up in ${seconds(a.nextInMs)}.`;
}

export function Kpis({
  sim,
  algorithm,
  allowance,
}: {
  sim: Simulation;
  algorithm: AlgorithmName;
  allowance: Availability | undefined;
}) {
  const seconds = RULE.windowMs / 1000;
  const allowed = allowedInLast(sim.responses, sim.now, RULE.windowMs);
  const refused = refusedInLast(sim.responses, sim.now, RULE.windowMs);
  const over = allowed > RULE.limit;

  return (
    <section className="kpis" aria-label="At a glance">
      <Kpi
        label={`Allowed, last ${String(seconds)} s`}
        tone={over ? 'bad' : undefined}
        foot={
          over
            ? OVER_TEXT[overReason(sim.responses, sim.now, RULE.windowMs, algorithm)]
            : 'Let through by all three servers together.'
        }
      >
        {allowed}
        <small> / {RULE.limit}</small>
      </Kpi>

      <Kpi
        label="Shared count, now"
        foot={sim.redisDown ? 'No shared count while Redis is down.' : shareText(allowance)}
      >
        {sim.redisDown || allowance === undefined ? (
          '—'
        ) : (
          <>
            {allowance.available}
            <small> left</small>
            <Meter allowance={allowance} />
          </>
        )}
      </Kpi>

      <Kpi
        label={`Refused, last ${String(seconds)} s`}
        tone={refused > 0 ? 'bad' : undefined}
        foot="Each got a 429 with Retry-After."
      >
        {refused}
      </Kpi>

      <Kpi
        label="Redis"
        tone={sim.redisDown ? 'bad' : 'ok'}
        foot={
          sim.redisDown
            ? 'Each server falls back to its own memory: 2 each.'
            : 'One count, shared by all three servers.'
        }
      >
        <span className="kpi-dot" aria-hidden="true" />
        {sim.redisDown ? 'Down' : 'Healthy'}
      </Kpi>
    </section>
  );
}
