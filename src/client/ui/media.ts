// Media queries that follow the listener's system settings and screen as they change.
import { readable, type Readable } from 'svelte/store';

export function mediaQuery(query: string): Readable<boolean> {
  return readable(matchMedia(query).matches, (set) => {
    const m = matchMedia(query);
    const on = () => set(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  });
}

/**
 * Calls `listener` when devicePixelRatio changes. A window dragged to a screen with another pixel
 * ratio keeps its CSS size, so a ResizeObserver on the content box never hears of it.
 */
export function onPixelRatioChange(listener: (dpr: number) => void): () => void {
  let m: MediaQueryList | null = null;
  const watch = () => {
    m = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    m.addEventListener('change', changed, { once: true });
  };
  const changed = () => {
    watch();
    listener(devicePixelRatio || 1);
  };
  watch();
  return () => m?.removeEventListener('change', changed);
}
