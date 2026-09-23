// What the UI holds on to: the engine, its clock, the stores the room writes, and the listener's
// outgoing gestures. Implemented by the socket connection and by the offline mock room.
import type { DockReaction } from '../../shared/music.ts';
import type { PadPoint, RequestAck } from '../../shared/protocol.ts';
import type { ClockSync, Engine } from '../engine/types.ts';
import type { RoomStores } from '../ui/stores.ts';

/** The server's ack, or a refusal before it answered: not connected yet, or no answer in time. */
export type RequestResult = RequestAck | { ok: false; error: 'offline' | 'timeout' };

export interface RoomActions {
  /** The listener's puck. Throttled to ≤ 4 Hz while `active`; a release is always sent. */
  pad(point: PadPoint, active: boolean): void;
  /** Stay (+1) / Move on (−1) for the section audible now. False if nothing is playing. */
  keep(v: 1 | -1): boolean;
  react(type: DockReaction): boolean;
  request(text: string): Promise<RequestResult>;
  vote(forkId: string, option: 'A' | 'B' | 'C'): void;
  /** Something the heartbeat reports changed (audibility, visibility, volume): report soon. */
  poke(): void;
}

export interface Room {
  readonly engine: Engine;
  readonly clock: ClockSync;
  readonly stores: RoomStores;
  readonly actions: RoomActions;
  readonly mock: boolean;
  destroy(): void;
}

export interface RoomOptions {
  stores: RoomStores;
  /** The listener's volume (0..1), for the heartbeat's "audible". */
  volume: () => number;
}
