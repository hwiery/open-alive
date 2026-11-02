import { useEffect, useState } from 'react';

export interface VisibleViewport {
  height: number;
  offsetTop: number;
}

function read(): VisibleViewport | null {
  const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
  return vv ? { height: vv.height, offsetTop: vv.offsetTop } : null;
}

/**
 * The part of the page the user can actually see.
 *
 * iOS Safari opens the soft keyboard over the layout viewport instead of
 * shrinking it, so a `position: fixed; inset: 0` shell keeps its input bar
 * under the keyboard. Sizing the shell to the visual viewport keeps the bar
 * just above it. Null where the browser has no visualViewport.
 */
export function useVisualViewport(): VisibleViewport | null {
  const [viewport, setViewport] = useState<VisibleViewport | null>(read);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setViewport({ height: vv.height, offsetTop: vv.offsetTop });
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return viewport;
}
