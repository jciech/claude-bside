// A CSS media query as a store that follows the listener's system settings as they change.
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
