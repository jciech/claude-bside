// Opens the live room, or the offline mock room with `?mock` in the URL (loaded on demand, so the
// live bundle doesn't carry the simulation or the fixture).
import type { RoomStores } from '../ui/stores.ts';
import { connectRoom } from './connection.ts';
import type { Room } from './types.ts';

export function isMockUrl(search: string): boolean {
  return new URLSearchParams(search).has('mock');
}

export async function openRoom(stores: RoomStores, volume: () => number, search = location.search): Promise<Room> {
  if (isMockUrl(search)) {
    const { createMockRoom } = await import('./mock.ts');
    return createMockRoom({ stores, volume });
  }
  return connectRoom({ stores, volume });
}
