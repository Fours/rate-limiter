import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** How often a held button sends, in real ms: 4 a second. */
export const HOLD_INTERVAL_MS = 250;

const isPress = (key: string) => key === ' ' || key === 'Enter';

/**
 * A button that calls `onTick` once when pressed, then every HOLD_INTERVAL_MS until released:
 * by mouse, touch, or Space or Enter held down.
 */
export function HoldButton({
  onTick,
  disabled,
  children,
}: {
  onTick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const tick = useRef(onTick);
  useEffect(() => {
    tick.current = onTick;
  }, [onTick]);

  const stop = useCallback(() => {
    window.clearInterval(timer.current);
    timer.current = undefined;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (timer.current !== undefined) return;
    tick.current();
    timer.current = window.setInterval(() => {
      tick.current();
    }, HOLD_INTERVAL_MS);
    setHolding(true);
  }, []);

  useEffect(
    () => () => {
      window.clearInterval(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      className="hold"
      data-holding={holding}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(e) => {
        if (!isPress(e.key)) return;
        // Space would scroll the page, and Enter would click.
        e.preventDefault();
        if (!e.repeat) start();
      }}
      onKeyUp={(e) => {
        if (isPress(e.key)) stop();
      }}
      onBlur={stop}
      onContextMenu={(e) => {
        // A long press on a phone would open the menu instead of holding.
        e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
