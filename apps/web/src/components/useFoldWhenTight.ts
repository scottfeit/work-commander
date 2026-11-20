import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Should a button row fold its less-used buttons into "More ▾"? True when the row's buttons, at their natural widths, don't fit
 * in `room` (the element whose width is the space the row may use). Re-checked as it resizes. The natural width is measured
 * while unfolded and remembered, so it can unfold again once there's room.
 */
export function useFoldWhenTight(room: RefObject<HTMLElement | null>, row: RefObject<HTMLElement | null>, deps: unknown[]) {
  const [folded, setFolded] = useState(false);
  const full = useRef(0);
  useLayoutEffect(() => {
    const r = room.current;
    const w = row.current;
    if (!r || !w) return;
    const check = () => {
      if (!folded) {
        const kids = [...w.children] as HTMLElement[];
        const gap = parseFloat(getComputedStyle(w).columnGap) || 0;
        full.current = kids.reduce((n, k) => n + k.scrollWidth, 0) + gap * Math.max(0, kids.length - 1);
      }
      setFolded(full.current > r.clientWidth + 0.5);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(r);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded, ...deps]);
  return folded;
}
