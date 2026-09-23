// Which pitch classes a section's scale allows at each moment. Scales may alternate per bar
// ("<D:dorian G:mixolydian>"), so the scale string is read as mini-notation and queried per bar.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import '@strudel/tonal';
import type { Issue } from '../shared/analysis.ts';
import { pitchClass } from './features.ts';
import { captureLogs, cycleState } from './query.ts';

export type ScaleLookup = (bar: number, pos: number) => Set<number> | null;
const scaleCache = new Map<string, Set<number> | null>();

/** Pitch classes of a Strudel scale name, computed by Strudel's own .scale() (so it matches playback). */
function scalePitchClasses(name: string): Set<number> | null {
  if (scaleCache.has(name)) return scaleCache.get(name)!;
  const { result } = captureLogs(() => {
    try {
      const pat = core.n(core.seq(...Array.from({ length: 12 }, (_, i) => i))).scale(name);
      const haps = pat.query(cycleState(0, 1, {})) as any[];
      const pcs = new Set<number>();
      for (const h of haps) {
        const note = h.value?.note;
        const midi = typeof note === 'string' ? core.noteToMidi(note) : typeof note === 'number' ? note : NaN;
        if (Number.isFinite(midi)) pcs.add(pitchClass(midi));
      }
      return pcs.size ? pcs : null;
    } catch {
      return null;
    }
  });
  scaleCache.set(name, result);
  return result;
}

const scaleIssue = (message: string, hint: string): Issue => ({ severity: 'error', rule: 'scale', message, path: 'scale', hint });

/** Scale lookup for bars 0…bars-1, or null (no scale given, or it is invalid: issues pushed to `errors`). */
export function resolveScales(scale: string | null, bars: number, errors: Issue[]): ScaleLookup | null {
  if (scale === null || scale.trim() === '') return null;
  let pattern: any;
  try {
    pattern = mini.mini(scale);
  } catch (e) {
    errors.push(scaleIssue(`The scale "${scale}" is not valid mini-notation: ${(e as Error).message}`, 'Write "D:dorian" or alternate per bar: "<D:dorian G:mixolydian>".'));
    return null;
  }
  const perBar: { begin: number; end: number; pcs: Set<number> }[][] = [];
  const invalid = new Set<string>();
  for (let bar = 0; bar < bars; bar++) {
    const haps = pattern.query(cycleState(bar, bar + 1, {})) as any[];
    perBar.push(
      haps.flatMap((h) => {
        const name = Array.isArray(h.value) ? h.value.join(':') : String(h.value);
        const pcs = scalePitchClasses(name);
        if (!pcs) {
          invalid.add(name);
          return [];
        }
        return [{ begin: h.part.begin.valueOf() - bar, end: h.part.end.valueOf() - bar, pcs }];
      }),
    );
  }
  for (const name of invalid) {
    errors.push(scaleIssue(`Unknown scale "${name}".`, 'Scales are written tonic:mode, e.g. "D:dorian", "A:minor:pentatonic", "C:major".'));
  }
  if (invalid.size) return null;
  return (bar, pos) => {
    const spans = perBar[bar];
    if (!spans) return null;
    return (spans.find((s) => pos >= s.begin - 1e-9 && pos < s.end) ?? spans[0])?.pcs ?? null;
  };
}
