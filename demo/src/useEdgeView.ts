// Whether the fixed-window view is open, kept in the address bar as #fixed-window, so Back closes
// it and a link can open it directly.
import { useCallback, useEffect, useState } from 'react';

export const EDGE_VIEW_HASH = '#fixed-window';

const isOpen = () => window.location.hash === EDGE_VIEW_HASH;
const openedHere = () => (window.history.state as { edgeView?: boolean } | null)?.edgeView === true;

export function useEdgeView() {
  const [open, setOpen] = useState(isOpen);

  useEffect(() => {
    const sync = () => {
      setOpen(isOpen());
    };
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  const show = useCallback(() => {
    if (!isOpen()) window.history.pushState({ edgeView: true }, '', EDGE_VIEW_HASH);
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    // Opened from the page: going back closes it, and Forward can reopen it. Arrived by a link:
    // there's no page behind it in this history, so drop the hash instead.
    if (openedHere()) {
      window.history.back();
      return;
    }
    const { pathname, search } = window.location;
    window.history.replaceState(null, '', pathname + search);
    setOpen(false);
  }, []);

  return { open, show, hide };
}
