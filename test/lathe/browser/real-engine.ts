// engine=real: the performer engine itself, booted from test/fixtures/snapshot.json (synth-only
// parts), its "server clock" this page's epoch time. Before the unlock it is silent and the Lathe
// plays from lookahead queries (the landing page); after it, haps and meters are real.
import { createEngine } from '../../../src/client/engine/engine.ts';
import type { ClockSync, Engine } from '../../../src/client/engine/types.ts';
import type { MovementInfo } from '../../../src/shared/program.ts';
import type { RoomSnapshot } from '../../../src/shared/protocol.ts';
import type { SideSection } from '../../../src/client/render/protocol.ts';

export interface Room {
  engine: Engine;
  movement: MovementInfo;
  sections: SideSection[];
  unlock: (() => Promise<void>) | null;
}

export async function realRoom(startCycle: number): Promise<Room> {
  const serverNow = () => performance.timeOrigin + performance.now();
  const clock: ClockSync = {
    serverNow,
    offsetMs: () => 0,
    rttMs: () => 0,
    jitterMs: () => 0,
    ready: Promise.resolve(),
    onStep: () => () => {},
    resync() {},
    stop() {},
  };
  const room = (await (await fetch('/fixtures/snapshot.json')).json()) as RoomSnapshot;
  const cps = room.timeline.segments[0]!.cps;
  const timeline = { segments: [{ startMs: serverNow() - (startCycle / cps) * 1000, startCycle: 0, cps }] };
  const engine = createEngine({ catalogUrl: '/fixtures/catalog.small.json', clock });
  engine.applySnapshot({ epoch: room.epoch, rev: room.rev, timeline, mixer: room.mixer, sections: room.sections });
  await engine.prepare();
  return {
    engine,
    movement: room.movements[0]!,
    sections: room.sections.map((s) => ({ id: s.id, name: s.name, role: s.role, startCycle: s.startCycle, bars: s.bars, provisional: s.provisional })),
    unlock: () => engine.unlock(),
  };
}
