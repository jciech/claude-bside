// Stay / Move on (ARCHITECTURE §8). Both edit the playing section's score time with a jump instead of
// moving its boundary blindly, so its ending (fills, riser tops, automation tails) still ends it:
// Stay repeats the penultimate 8-bar phrase, Move on skips from the next 8-bar line to the final
// phrase. Successors shift by the change in planned length. Every change must still be ahead of the
// lock: the jump's own cycle and, for the successor, its lock point at its new position.
import type { KeepPending } from '../../shared/protocol.ts';
import type { SectionProgram } from '../../shared/program.ts';
import { KEEP_PHRASE_BARS, lockMs, plannedPlayBars, scoreBarAt, type Jump } from '../../shared/schedule.ts';
import type { SectionRole } from '../../shared/music.ts';
import type { Timeline } from '../../shared/timeline.ts';
import { ACCEPT_MARGIN_MS, changeableAt, isHardLocked, plannedEnd } from './placement.ts';

const NO_STAY: ReadonlySet<SectionRole> = new Set(['intro', 'build', 'transition']);
const MAX_STAYS = 2;

export type Blocked = NonNullable<KeepPending['blocked']>;

export type KeepOutcome =
  | { ok: true; kind: KeepPending['kind']; jumps: Jump[]; shift: number; atCycle: number | null; needsPlan: boolean }
  | { ok: false; kind: KeepPending['kind']; blocked: Blocked };

export interface KeepInput {
  current: SectionProgram;
  next: SectionProgram | null;
  direction: 1 | -1;
  timeline: Timeline;
  nowMs: number;
  nowCycle: number;
}

/** Play bar at which each jump happens, in order. */
function jumpPlays(jumps: readonly Jump[]): number[] {
  let play0 = 0;
  let score0 = 0;
  return jumps.map((j) => {
    play0 += j.atBar - score0;
    score0 = j.toBar;
    return play0;
  });
}

/** A ramp into the section's end moves with the end: both its old and new start must be changeable. */
function endRampMovable(s: SectionProgram, newEnd: number, timeline: Timeline, nowMs: number): boolean {
  if (s.tempo.rampAt !== 'end' || s.tempo.rampBars <= 0) return true;
  const oldStart = plannedEnd(s) - s.tempo.rampBars;
  const newStart = newEnd - s.tempo.rampBars;
  return changeableAt(timeline, Math.min(oldStart, newStart), nowMs);
}

export function decideKeep(input: KeepInput): KeepOutcome {
  return input.direction === 1 ? stay(input) : moveOn(input);
}

function stay({ current: s, next, timeline, nowMs }: KeepInput): KeepOutcome {
  const blocked = (b: Blocked): KeepOutcome => ({ ok: false, kind: 'extend', blocked: b });
  if (NO_STAY.has(s.role)) return blocked('role');
  if (s.jumps.filter((j) => j.atBar > j.toBar).length >= MAX_STAYS) return blocked('max');
  const jump: Jump = s.bars >= 2 * KEEP_PHRASE_BARS ? { atBar: s.bars - KEEP_PHRASE_BARS, toBar: s.bars - 2 * KEEP_PHRASE_BARS } : { atBar: s.bars, toBar: 0 };
  const play0 = jumpPlays(s.jumps).at(-1) ?? 0;
  const score0 = s.jumps.at(-1)?.toBar ?? 0;
  if (jump.atBar < score0) return blocked('locked');
  const at = s.startCycle + play0 + (jump.atBar - score0);
  const shift = jump.atBar - jump.toBar;
  if (!changeableAt(timeline, at, nowMs) || !endRampMovable(s, plannedEnd(s) + shift, timeline, nowMs)) return blocked('locked');
  if (next && isHardLocked(timeline, next, nowMs)) return blocked('locked');
  return { ok: true, kind: 'extend', jumps: [...s.jumps, jump], shift, atCycle: at, needsPlan: false };
}

function moveOn({ current: s, next, timeline, nowMs, nowCycle }: KeepInput): KeepOutcome {
  const blocked = (b: Blocked): KeepOutcome => ({ ok: false, kind: 'shorten', blocked: b });
  if (!next && nowCycle >= plannedEnd(s)) return { ok: true, kind: 'shorten', jumps: s.jumps, shift: 0, atCycle: null, needsPlan: true };
  const total = plannedPlayBars(s);
  const plays = jumpPlays(s.jumps);
  const played = nowCycle - s.startCycle;
  let reason: Blocked = 'min-length';
  for (let line = Math.max(KEEP_PHRASE_BARS, Math.floor(played / KEEP_PHRASE_BARS + 1) * KEEP_PHRASE_BARS); line < total; line += KEEP_PHRASE_BARS) {
    const kept = s.jumps.filter((_, i) => plays[i]! < line);
    const scoreAtLine = scoreBarAt({ bars: s.bars, jumps: kept, vamp: s.vamp }, line);
    if (scoreAtLine >= s.bars - KEEP_PHRASE_BARS) break;
    const shift = s.startCycle + line + KEEP_PHRASE_BARS - plannedEnd(s);
    if (!changeableAt(timeline, s.startCycle + line, nowMs) || !endRampMovable(s, plannedEnd(s) + shift, timeline, nowMs)) {
      reason = 'locked';
      continue;
    }
    if (next && lockMs(timeline, { ...next, startCycle: next.startCycle + shift }) <= nowMs + ACCEPT_MARGIN_MS) {
      reason = 'next-not-ready';
      continue;
    }
    return {
      ok: true,
      kind: 'shorten',
      jumps: [...kept, { atBar: scoreAtLine, toBar: s.bars - KEEP_PHRASE_BARS }],
      shift,
      atCycle: s.startCycle + line,
      needsPlan: !next,
    };
  }
  return blocked(reason);
}
