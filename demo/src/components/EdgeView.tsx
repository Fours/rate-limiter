// The fixed-window comparison, full screen, over the dashboard. Opened from the teaser in the
// top bar, the hint under "Fixed window", or a link to #fixed-window. It runs on its own clock
// and store.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ALGORITHM_COPY } from '../algorithms.ts';
import { maxAllowedInAnyWindow } from '../sim/timeline.ts';
import { COMPARED, EDGE_RULE, type EdgeLab } from '../useEdgeLab.ts';
import {
  EDGE_EXPLAINER,
  EdgeControls,
  EdgeSummary,
  EdgeTable,
  seconds,
} from './EdgeComparison.tsx';
import { CloseIcon, SplitWindowIcon } from './icons.tsx';
import { Lanes, type Lane } from './Lanes.tsx';
import { statusText } from './ResponseDetails.tsx';
import './edge-view.css';

export function EdgeView({ lab, onClose }: { lab: EdgeLab; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);

  // Behind it, the page is inert and doesn't scroll. Focus starts on Close and goes back to
  // whatever opened the view when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    return () => {
      root?.removeAttribute('inert');
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  const { windowMs, limit } = EDGE_RULE;
  const times = lab.compared.map((r) => r.at);
  const from = times.length === 0 ? lab.now - 2_000 : Math.min(...times) - 400;
  const to = times.length === 0 ? lab.now : Math.max(...times) + 400;
  const lanes: Lane[] = COMPARED.map((name) => {
    const own = lab.compared.filter((r) => r.algorithm === name);
    return {
      key: name,
      label: (
        <>
          <strong>{ALGORITHM_COPY[name].name}</strong>
          <span className="lane-sub">{maxAllowedInAnyWindow(own, windowMs)} in any 10 s</span>
        </>
      ),
      marks: own.map((r) => ({
        key: `${String(r.seq)}-${r.algorithm}`,
        at: r.at,
        status: r.status,
        title: `${seconds(r.at - lab.startMs, 2)}: ${statusText(r)}`,
      })),
    };
  });

  return createPortal(
    <div
      className="edge-view"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edge-heading"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      onClick={(e) => {
        // A click on the dimmed dashboard around the sheet closes it, as Escape does.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ev-sheet">
        <header className="ev-top">
          <div>
            <p className="ev-kicker">A closer look</p>
            <h2 id="edge-heading">Where the fixed window slips</h2>
          </div>
          <button ref={close} type="button" className="ev-close" onClick={onClose}>
            <CloseIcon />
            Close
          </button>
        </header>

        <div className="ev-body">
          <section className="ev-intro ev-panel" aria-label="What this shows">
            <p>{EDGE_EXPLAINER}</p>
            <p className="ev-muted">
              Both get exactly the same requests, from the same visitor, at the same moments. The
              limit is {limit} every {windowMs / 1000} seconds. This view keeps its own time, so the
              dashboard behind it is left as it was.
            </p>
            {lab.state.kind === 'failed' && <p role="alert">Couldn’t start: {lab.state.error}</p>}
            <EdgeControls lab={lab} />
            <EdgeSummary responses={lab.compared} />
          </section>

          <section className="ev-chart ev-panel" aria-labelledby="ev-chart-heading">
            <div className="ev-head">
              <h3 id="ev-chart-heading">Request by request</h3>
              <span className="ev-legend" aria-hidden="true">
                <span className="lane-mark" data-status="200" /> allowed
                <span className="lane-mark" data-status="429" /> refused
                <span className="ev-edge-key" /> new 10-second block
              </span>
            </div>
            {lab.compared.length === 0 ? (
              <p className="ev-muted ev-empty">
                Press <em>Burst across the edge</em> to send the same 12 requests to both.
              </p>
            ) : (
              <Lanes
                label="The comparison, request by request"
                lanes={lanes}
                from={from}
                to={to}
                windowMs={windowMs}
                startMs={lab.startMs}
              />
            )}
          </section>

          <section className="ev-table ev-panel" aria-label="Every request">
            <div className="ev-scroll">
              <EdgeTable responses={lab.compared} startMs={lab.startMs} />
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** What the dashboard shows in the view's place: a line about it and a way in. */
export function EdgeTeaser({ onOpen }: { onOpen: () => void }) {
  return (
    <aside className="edge-teaser" aria-label="The fixed window’s weak spot">
      <span className="teaser-icon">
        <SplitWindowIcon size={16} />
      </span>
      <p>
        <strong>Two of these algorithms can disagree by 2×</strong>
        <span>Same requests, 12 allowed versus 6.</span>
      </p>
      <button type="button" className="secondary" onClick={onOpen}>
        See where the fixed window slips <span aria-hidden="true">→</span>
      </button>
    </aside>
  );
}
