// Plain-language wording for everything the room shows: numbers, statuses and the crowd's state in
// words (docs/DESIGN.md "Accessibility": no jargon, statuses in words). Pure.
import { cpsToBpm, type SectionRole } from '../../shared/music.ts';
import type { ComposerStatus, KeepPending, NackReason, PadPoint, RequestStatus } from '../../shared/protocol.ts';
import type { RequestResult } from '../room/types.ts';

/** Side 1 → "A", 2 → "B" … 27 → "AA". */
export function sideLetter(side: number): string {
  let n = Math.max(1, Math.floor(side));
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function bar(cycle: number): number {
  return Math.floor(cycle + 1e-6);
}

export function bpmOf(cps: number): number {
  return Math.round(cpsToBpm(cps));
}

/** "D:dorian" → "D dorian"; "C:minor:pentatonic" → "C minor pentatonic"; "<D:dorian G:mixolydian>" → "D dorian / G mixolydian". */
export function scaleLabel(scale: string): string {
  const names = scale
    .replace(/[<>[\]]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.replace(/[:_]/g, ' '));
  return [...new Set(names)].join(' / ');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const ROLE_NOUN: Record<SectionRole, string> = {
  intro: 'intro',
  groove: 'next track',
  build: 'build',
  drop: 'drop',
  breakdown: 'breakdown',
  bridge: 'bridge',
  interlude: 'interlude',
  outro: 'outro',
  transition: 'transition',
  reprise: 'reprise',
};

/** "drop in 6 bars", "next track in 1 bar", "drop now". */
export function cueText(role: SectionRole, barsAway: number): string {
  const noun = ROLE_NOUN[role];
  if (barsAway <= 0) return `${noun} now`;
  return `${noun} in ${plural(barsAway, 'bar')}`;
}

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  received: 'received',
  considered: 'Claude is weighing it',
  planned: 'coming up',
  'next-movement': 'next side',
  'fork-option': 'on the ballot',
  merged: 'merged',
  declined: 'not now',
  playing: 'in the mix',
  played: 'played',
  expired: 'expired',
};

/** Statuses after which a request will not change any more. */
export const REQUEST_FINAL: ReadonlySet<RequestStatus> = new Set(['declined', 'played', 'expired', 'merged']);

export type RequestErrorCode = Extract<RequestResult, { ok: false }>['error'];

const REQUEST_ERRORS: Record<RequestErrorCode, string> = {
  'too-early': 'Listen for a few more seconds first, then ask.',
  'rate-limited': 'One ask a minute. Try again shortly.',
  'room-busy': 'Lots of asks right now. Try again in a moment.',
  empty: 'Say a little more.',
  invalid: 'That didn’t go through. Try rephrasing.',
  'hello-first': 'Still joining the room. Try again in a moment.',
  offline: 'You’re offline. Your ask will need resending.',
  timeout: 'No answer from the room. Try again.',
};

export function requestErrorText(error: RequestErrorCode): string {
  // A newer server may send a code this client doesn't know yet.
  return REQUEST_ERRORS[error] ?? 'That didn’t go through. Try again.';
}

/** What the dock and the vote card say when the server refuses a press; null says nothing. */
const NACK_TEXT: Record<NackReason, string | null> = {
  'rate-limited': 'Easy — give it a second.',
  'heard-cycle': 'That landed too late to count.',
  'wrong-section': 'That track had already ended.',
  'section-ended': 'That track had already ended.',
  'too-early': 'Your presses start counting after a few seconds of listening.',
  closed: 'The vote has closed.',
  'no-fork': 'There’s no vote open right now.',
  'invalid-option': null,
  'unknown-event': null,
  invalid: null,
  internal: null,
  'hello-first': null,
  'room-full': null,
  'too-many-tabs': null,
  'not-sampled': null,
  empty: null,
  'room-busy': null,
};

export function nackText(reason: NackReason): string | null {
  return NACK_TEXT[reason] ?? null;
}

/**
 * What the room is doing about Stay / Move on. `endCycle` is where the current track ends as
 * planned (the next section's start), when known.
 */
export function keepPendingText(p: KeepPending, nowCycle: number, endCycle: number | null): string {
  const verb = p.kind === 'extend' ? 'stay' : 'move on';
  const left = endCycle === null ? null : Math.max(0, Math.ceil(endCycle - nowCycle));
  if (p.atCycle !== null) {
    return p.kind === 'extend' ? `Staying another phrase from bar ${bar(p.atCycle)}` : `Moving on at bar ${bar(p.atCycle)}`;
  }
  switch (p.blocked) {
    case 'min-length':
      return left !== null ? `This track ends in ${plural(left, 'bar')} anyway` : 'This track is already on its last phrase';
    case 'locked':
      if (p.kind === 'extend') return 'This track can’t hold any longer';
      return left !== null ? `Too close to change — it ends in ${plural(left, 'bar')}` : 'Too close to the change to skip';
    case 'next-not-ready':
      return 'Claude is still lining up what comes next';
    case 'max':
      return 'Already held twice';
    case 'role':
      return 'This part of the side is going somewhere — it can’t repeat';
    case null:
      break;
  }
  const held = Math.min(p.heldBars, p.needBars);
  return `The room leans ${verb} · ${held} of ${plural(p.needBars, 'bar')}`;
}

/** The composer's state as one line ("Claude is listening to the band vamp"). */
export function composerLine(c: ComposerStatus, serverNowMs: number): string {
  if (c.note) return c.note;
  const who = c.driver === 'claude' ? 'Claude' : c.driver === 'external' ? 'The guest composer' : 'The autopilot';
  switch (c.state) {
    case 'planning':
      return `${who} is writing what comes next`;
    case 'waiting':
      return `${who} is waiting for its moment`;
    case 'failed':
      return `${who} is taking a breath — the band keeps playing`;
    case 'paused':
      return `${who} is resting — the band keeps playing`;
    case 'idle':
      break;
  }
  if (c.nextDecisionAtMs !== null) {
    const s = Math.round((c.nextDecisionAtMs - serverNowMs) / 1000);
    if (s > 5) return `${who} decides again in ~${s < 90 ? `${Math.round(s / 5) * 5} s` : `${Math.round(s / 60)} min`}`;
    return `${who} is about to decide`;
  }
  return `${who} is listening`;
}

const BYLINE: Record<ComposerStatus['driver'], string> = { claude: 'Claude · live', external: 'Guest composer · live', scripted: 'Autopilot · live' };

/** The record label's byline: who is cutting the record. */
export function composerByline(driver: ComposerStatus['driver']): string {
  return BYLINE[driver];
}

function degree(v: number): string {
  const a = Math.abs(v);
  if (a < 0.08) return '';
  if (a < 0.35) return 'a little ';
  if (a < 0.7) return '';
  return 'much ';
}

/** Verbal slider value for the pad axes ("a little brighter", "much calmer", "neutral"). */
export function axisWords(axis: 'x' | 'y', v: number): string {
  if (Math.abs(v) < 0.08) return 'neutral';
  const word = axis === 'x' ? (v > 0 ? 'brighter' : 'darker') : v > 0 ? 'more intense' : 'calmer';
  return `${degree(v)}${word}`.trim();
}

/** "a little brighter and much calmer" for a whole point. */
export function padWords(p: PadPoint): string {
  const parts = [axisWords('x', p.x), axisWords('y', p.y)].filter((w) => w !== 'neutral');
  return parts.length ? parts.join(' and ') : 'right in the middle';
}

/** Bars the room's pull takes to move the music noticeably (server EMA τ, docs/ARCHITECTURE.md §8). */
export function driftBars(listeners: number, cps: number): number {
  const tau = Math.min(60, Math.max(8, 6 + 12 * Math.log(1 + Math.max(1, listeners))));
  return Math.max(4, Math.round((tau * cps) / 4) * 4);
}

/**
 * The status line under the pad: where the music is heading relative to where the room pulls.
 * `needle` is the music, `pull` the room.
 */
export function driftText(needle: PadPoint, pull: PadPoint, opts: { listeners: number; turnout: number; cps: number; split: null | { axis: 'x' | 'y' } }): string {
  if (opts.split) {
    return opts.split.axis === 'x' ? 'The room is split between darker and brighter.' : 'The room is split between calmer and more intense.';
  }
  if (opts.turnout <= 0.001) return 'Nobody is steering. Drag to lean the room.';
  const dx = pull.x - needle.x;
  const dy = pull.y - needle.y;
  if (Math.abs(dx) < 0.08 && Math.abs(dy) < 0.08) return 'The music is where the room wants it.';
  const parts = [axisWords('x', dx), axisWords('y', dy)].filter((w) => w !== 'neutral');
  return `The music is drifting ${parts.join(' and ')} over the next ~${driftBars(opts.listeners, opts.cps)} bars.`;
}

/** Identity hues are a separate family from the voice colours (docs/DESIGN.md). */
export function hueColor(hue: number): string {
  return `hsl(${Math.round(hue) % 360} 55% 70%)`;
}
