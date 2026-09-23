import { describe, expect, it } from 'vitest';
import {
  axisWords,
  composerLine,
  cueText,
  driftBars,
  driftText,
  keepPendingText,
  nackText,
  padWords,
  requestErrorText,
  scaleLabel,
  sideLetter,
  type RequestErrorCode,
} from '../../src/client/ui/format.ts';
import { NACK_REASONS, REQUEST_ERRORS, type ComposerStatus, type KeepPending } from '../../src/shared/protocol.ts';

describe('formatting', () => {
  it('names sides like records', () => {
    expect([1, 2, 26, 27, 28].map(sideLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB']);
  });

  it('reads scales and alternations', () => {
    expect(scaleLabel('D:dorian')).toBe('D dorian');
    expect(scaleLabel('<D:dorian G:mixolydian>')).toBe('D dorian / G mixolydian');
    expect(scaleLabel('C:minor:pentatonic')).toBe('C minor pentatonic');
    expect(scaleLabel('D:purvi:raga')).toBe('D purvi raga');
  });

  it('counts down cues in bars', () => {
    expect(cueText('drop', 6)).toBe('drop in 6 bars');
    expect(cueText('groove', 1)).toBe('next track in 1 bar');
    expect(cueText('breakdown', 0)).toBe('breakdown now');
  });

  it('says what the pad means in words', () => {
    expect(axisWords('x', 0.02)).toBe('neutral');
    expect(axisWords('x', 0.2)).toBe('a little brighter');
    expect(axisWords('y', -0.9)).toBe('much calmer');
    expect(padWords({ x: 0.5, y: 0 })).toBe('brighter');
    expect(padWords({ x: 0, y: 0 })).toBe('right in the middle');
  });

  it('describes the drift from the music toward the room', () => {
    const opts = { listeners: 3, turnout: 0.5, cps: 0.5, split: null };
    expect(driftText({ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, opts)).toBe(`The music is drifting brighter and a little more intense over the next ~${driftBars(3, 0.5)} bars.`);
    expect(driftText({ x: 0.3, y: 0 }, { x: 0.32, y: 0.01 }, opts)).toBe('The music is where the room wants it.');
    expect(driftText({ x: 0, y: 0 }, { x: 1, y: 1 }, { ...opts, turnout: 0 })).toMatch(/Nobody is steering/);
    expect(driftText({ x: 0, y: 0 }, { x: 0, y: 0 }, { ...opts, split: { axis: 'y' } })).toMatch(/split between calmer and more intense/);
  });

  it('drift horizons grow with the room and are whole phrases', () => {
    expect(driftBars(1, 0.5) % 4).toBe(0);
    expect(driftBars(200, 0.5)).toBeGreaterThan(driftBars(2, 0.5));
  });

  it('explains Stay / Move on in plain words', () => {
    const base: KeepPending = { kind: 'shorten', heldBars: 3, needBars: 8, atCycle: null, blocked: null };
    expect(keepPendingText(base, 60, 80)).toBe('The room leans move on · 3 of 8 bars');
    expect(keepPendingText({ ...base, atCycle: 72 }, 60, 80)).toBe('Moving on at bar 72');
    expect(keepPendingText({ ...base, blocked: 'min-length' }, 74, 80)).toBe('This track ends in 6 bars anyway');
    expect(keepPendingText({ ...base, kind: 'extend', atCycle: 88 }, 60, 96)).toBe('Staying another phrase from bar 88');
    expect(keepPendingText({ ...base, kind: 'extend', blocked: 'role' }, 60, 96)).toMatch(/can’t repeat/);
    expect(keepPendingText({ ...base, blocked: 'next-not-ready' }, 60, null)).toMatch(/Claude is still lining up/);
    expect(keepPendingText({ ...base, kind: 'extend', blocked: 'max' }, 60, 96)).toBe('Already held twice');
  });

  it('turns composer state into a line', () => {
    const c: ComposerStatus = { driver: 'claude', state: 'idle', horizonSec: 90, lastPlanAt: null, nextDecisionAtMs: 41_000, note: null };
    expect(composerLine(c, 0)).toBe('Claude decides again in ~40 s');
    expect(composerLine({ ...c, state: 'planning' }, 0)).toBe('Claude is writing what comes next');
    expect(composerLine({ ...c, driver: 'scripted', state: 'failed' }, 0)).toMatch(/^The autopilot/);
    expect(composerLine({ ...c, note: 'Claude is listening to the band vamp' }, 0)).toBe('Claude is listening to the band vamp');
  });

  it('never shows raw error codes', () => {
    const codes: RequestErrorCode[] = [...REQUEST_ERRORS, 'offline', 'timeout'];
    for (const code of codes) expect(requestErrorText(code)).not.toMatch(/-/);
    expect(requestErrorText('something-new' as RequestErrorCode)).toBe('That didn’t go through. Try again.');
    for (const reason of NACK_REASONS) expect(nackText(reason) ?? '').not.toMatch(/-/);
    expect(nackText('rate-limited')).toBe('Easy — give it a second.');
  });
});
