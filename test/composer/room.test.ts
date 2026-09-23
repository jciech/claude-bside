// The autopilot in a real room: the real conductor (with its test clock, crowd and broadcaster) and
// the real checker. Every plan it writes must be accepted as-is — no fallback to the conductor's own
// carry, no rejected commits — across several movements, and after a handoff it must carry the other
// composer's material before moving on to its own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChecker } from '../../src/server/check/checker.ts';
import { isCarryName } from '../../src/server/composer/carry.ts';
import { createScriptedComposer } from '../../src/server/composer/scripted.ts';
import type { SectionProgram } from '../../src/shared/program.ts';
import type { Checker, ScriptedComposer } from '../../src/server/types.ts';
import { createManualComposer, createRoom, part, plan, section, type Room } from '../conductor/harness.ts';
import { fullCatalog, memoryLog } from './fixtures.ts';

/** Advances the room's clock in small steps, giving the real checker real time to answer. */
async function play(room: Room, seconds: number): Promise<void> {
  for (let t = 0; t < seconds * 2; t++) {
    await room.clock.advance(500);
    await new Promise((r) => setTimeout(r, 4));
  }
}

function sections(room: Room): SectionProgram[] {
  const byId = new Map<string, SectionProgram>();
  for (const update of room.broadcaster.of('schedule')) for (const s of update.upserts) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.startCycle - b.startCycle);
}

/** Anything that means an autopilot plan was not accepted as written. */
const trouble = (room: Room) =>
  room.log.lines
    .filter((l) => /fallback plan rejected|nothing could be committed|boot section rejected/.test(l.msg) || (l.msg.includes('composer gave up') && l.data?.author === 'scripted'))
    .map((l) => `${l.msg} ${JSON.stringify(l.data)}`);

describe('the autopilot with the real conductor and checker', () => {
  let checker: Checker;
  let scripted: ScriptedComposer;

  beforeAll(async () => {
    checker = createChecker({ catalog: fullCatalog, poolSize: 3 });
    scripted = await createScriptedComposer({ catalog: fullCatalog, checker, log: memoryLog() });
  }, 60_000);
  afterAll(() => checker.close());

  it('boots the room and composes movement after movement, every plan accepted', async () => {
    const room = createRoom({ checker, composers: { claude: createManualComposer('claude'), external: createManualComposer('external'), scripted }, config: { driver: 'scripted' } as never });
    await room.conductor.start();
    await play(room, 900);
    const played = sections(room);
    expect(trouble(room)).toEqual([]);
    expect(played.length).toBeGreaterThanOrEqual(12);
    expect(played.every((s) => s.author === 'scripted')).toBe(true);
    expect(new Set(played.map((s) => s.movementId)).size).toBeGreaterThanOrEqual(2);
    expect([...new Set(played.map((s) => s.role))]).toEqual(expect.arrayContaining(['intro', 'groove', 'build', 'drop', 'breakdown', 'outro']));
    // Consecutive sections of one ensemble continue their parts instead of restarting them.
    expect(played.some((s) => s.parts.some((p) => p.continues))).toBe(true);
    // The schedule is gapless: each section starts where the previous one ended or later (a vamp).
    for (let i = 1; i < played.length; i++) expect(played[i]!.startCycle).toBeGreaterThanOrEqual(played[i - 1]!.startCycle + 8);
  }, 120_000);

  it('after a handoff it carries the other composer\'s parts, then moves on to its own material', async () => {
    const room = createRoom({ checker, composers: { claude: createManualComposer('claude'), external: createManualComposer('external'), scripted }, config: { driver: 'external' } as never });
    await room.conductor.start();
    const boot = room.conductor.snapshot().sections[0]!;
    await room.clock.toCycle(boot.startCycle + 2);
    const foreign = plan([
      section({
        name: 'Glass Harbour',
        role: 'groove',
        bars: 32,
        bpm: boot.tempo.toBpm,
        scale: 'C:dorian',
        parts: [
          part('kick', { role: 'kick', code: 's("sbd*4").decay(0.3).gain(0.85)', level: 0.9 }),
          part('bass', { role: 'bass', code: 'n("<0 3 5 2>").scale("C2:dorian").s("sawtooth").lpf(knob("cut")).decay(0.2).sustain(0.3).gain(0.55)', knobs: [{ name: 'cut', default: 800, min: 300, max: 2400, follows: 'brightness' }], level: 0.7 }),
          part('hats', { role: 'hats', code: 's("white*8").hpf(8000).decay(0.03).gain(0.2)', level: 0.6 }),
          part('keys', { role: 'chords', code: 'n("<[0,2,4] [3,5,7]>").scale("C3:dorian").s("triangle").attack(0.3).release(1).gain(0.3)', level: 0.5 }),
        ],
      }),
    ]);
    const committed = await room.conductor.commit({ plan: foreign }, 'external');
    expect(committed.errors).toEqual([]);
    // Nobody at the terminal: every request times out and the autopilot fills in.
    await play(room, 600);
    expect(trouble(room)).toEqual([]);
    const played = sections(room);
    const at = played.findIndex((s) => s.author === 'external');
    const after = played.slice(at + 1);
    const carried = after.filter((s) => isCarryName(s.name));
    expect(carried.length).toBe(3);
    for (const s of carried) {
      expect(s.author).toBe('scripted');
      expect(s.parts.map((p) => p.id).sort()).toEqual(['bass', 'hats', 'keys', 'kick']);
      expect(s.parts.every((p) => p.continues)).toBe(true);
    }
    expect(carried.map((s) => s.role)).toEqual(['groove', 'groove', 'breakdown']);
    const own = after.slice(carried.length);
    expect(own.length).toBeGreaterThan(0);
    expect(own[0]!.parts.some((p) => !['bass', 'hats', 'keys', 'kick'].includes(p.id) || !p.carried)).toBe(true);
  }, 120_000);
});
