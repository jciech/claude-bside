// Stay / Move on (ARCHITECTURE §8). Both edit the playing section's score time with a jump instead of
// moving its boundary blindly, so its ending (fills, riser tops, automation tails) still ends it:
// Stay repeats the penultimate 8-bar phrase, Move on skips from the next 8-bar line to the final
// phrase (dropping any Stay not reached yet). Successors shift by the change in where the section
// really ends. Every change must still be ahead of the lock: the jump's own cycle and, for the
// successor, its lock point at its new position.
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

/**
 * Where the section really stops: its planned end, or earlier when a successor committed with
 * `next`/`now` cut in before it (a later successor means it vamps meanwhile; the gap moves along).
 */
const actualEnd = (s: SectionProgram, next: SectionProgram | null) => Math.min(plannedEnd(s), next?.startCycle ?? Infinity);

/** Jumps played before `playBar` (later ones are still pending). */
function jumpsBefore(s: SectionProgram, playBar: number): Jump[] {
  const plays = jumpPlays(s.jumps);
  return s.jumps.filter((_, i) => plays[i]! < playBar);
}

function stay({ current: s, next, timeline, nowMs }: KeepInput): KeepOutcome {
  const blocked = (b: Blocked): KeepOutcome => ({ ok: false, kind: 'extend', blocked: b });
  if (NO_STAY.has(s.role)) return blocked('role');
  if (s.jumps.filter((j) => j.atBar > j.toBar).length >= MAX_STAYS) return blocked('max');
  const cutAt = actualEnd(s, next) - s.startCycle;
  let jumps: Jump[];
  let at: number;
  if (cutAt < plannedPlayBars(s)) {
    // The successor cuts in before the ending: repeat the phrase just before the cut, where it is heard.
    const kept = jumpsBefore(s, cutAt);
    const atBar = scoreBarAt({ bars: s.bars, jumps: kept, vamp: s.vamp }, cutAt);
    jumps = [...kept, { atBar, toBar: Math.max(0, atBar - KEEP_PHRASE_BARS) }];
    at = s.startCycle + cutAt;
  } else {
    const jump: Jump = s.bars >= 2 * KEEP_PHRASE_BARS ? { atBar: s.bars - KEEP_PHRASE_BARS, toBar: s.bars - 2 * KEEP_PHRASE_BARS } : { atBar: s.bars, toBar: 0 };
    const play0 = jumpPlays(s.jumps).at(-1) ?? 0;
    const score0 = s.jumps.at(-1)?.toBar ?? 0;
    if (jump.atBar < score0) return blocked('locked');
    jumps = [...s.jumps, jump];
    at = s.startCycle + play0 + (jump.atBar - score0);
  }
  const jump = jumps.at(-1)!;
  const shift = jump.atBar - jump.toBar;
  if (shift <= 0) return blocked('locked');
  if (!changeableAt(timeline, at, nowMs) || !endRampMovable(s, s.startCycle + plannedPlayBars({ bars: s.bars, jumps }), timeline, nowMs)) return blocked('locked');
  if (next && isHardLocked(timeline, next, nowMs)) return blocked('locked');
  return { ok: true, kind: 'extend', jumps, shift, atCycle: at, needsPlan: false };
}

function moveOn({ current: s, next, timeline, nowMs, nowCycle }: KeepInput): KeepOutcome {
  const blocked = (b: Blocked): KeepOutcome => ({ ok: false, kind: 'shorten', blocked: b });
  if (!next && nowCycle >= plannedEnd(s)) return { ok: true, kind: 'shorten', jumps: s.jumps, shift: 0, atCycle: null, needsPlan: true };
  const end = actualEnd(s, next);
  const played = nowCycle - s.startCycle;
  let reason: Blocked = 'min-length';
  for (let line = Math.max(KEEP_PHRASE_BARS, Math.floor(played / KEEP_PHRASE_BARS + 1) * KEEP_PHRASE_BARS); s.startCycle + line < end; line += KEEP_PHRASE_BARS) {
    // Jumps still ahead of the line are dropped: Move on cancels a pending Stay.
    const kept = jumpsBefore(s, line);
    const scoreAtLine = scoreBarAt({ bars: s.bars, jumps: kept, vamp: s.vamp }, line);
    const jumps = scoreAtLine < s.bars - KEEP_PHRASE_BARS ? [...kept, { atBar: scoreAtLine, toBar: s.bars - KEEP_PHRASE_BARS }] : kept;
    const newEnd = s.startCycle + plannedPlayBars({ bars: s.bars, jumps });
    const shift = newEnd - end;
    // Later lines keep more of the section, so none of them could shorten it either.
    if (shift >= 0) break;
    if (!changeableAt(timeline, s.startCycle + line, nowMs) || !endRampMovable(s, newEnd, timeline, nowMs)) {
      reason = 'locked';
      continue;
    }
    if (next && lockMs(timeline, { ...next, startCycle: next.startCycle + shift }) <= nowMs + ACCEPT_MARGIN_MS) {
      reason = 'next-not-ready';
      continue;
    }
    return { ok: true, kind: 'shorten', jumps, shift, atCycle: s.startCycle + line, needsPlan: !next };
  }
  return blocked(reason);
}
