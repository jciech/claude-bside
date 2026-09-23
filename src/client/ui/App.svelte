<script lang="ts">
  import { get } from 'svelte/store';
  import { openRoom } from '../room/open.ts';
  import ListeningRoom from './ListeningRoom.svelte';
  import BrandMark from './components/BrandMark.svelte';
  import { createSettings } from './settings.ts';
  import { createRoomStores } from './stores.ts';

  const stores = createRoomStores();
  const settings = createSettings();
  const opening = openRoom(stores, () => get(settings).volume);
</script>

{#await opening}
  <div class="boot" aria-busy="true" aria-label="Tuning in to the room">
    <BrandMark size={56} spin />
  </div>
{:then room}
  <ListeningRoom {room} {settings} />
{:catch error}
  <div class="boot">
    <BrandMark size={56} />
    <p role="alert">The room couldn’t open: {error instanceof Error ? error.message : String(error)}</p>
  </div>
{/await}

<style>
  .boot {
    min-height: 100dvh;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--s-4);
    color: var(--paper-2);
    font-size: var(--t-sm);
    padding: var(--gutter);
    text-align: center;
  }
</style>
