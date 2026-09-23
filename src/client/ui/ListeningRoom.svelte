<script lang="ts">
  import { flushSync, onDestroy, tick } from 'svelte';
  import { derived, readable, writable, type Writable } from 'svelte/store';
  import type { PartError } from '../engine/types.ts';
  import type { Room } from '../room/types.ts';
  import { provideRoom, type Layout } from './context.ts';
  import { mediaQuery } from './media.ts';
  import { startPulse } from './pulse.ts';
  import type { Settings } from './settings.ts';
  import { nowPlaying } from './now.ts';
  import { sideLetter } from './format.ts';
  import AskPanel from './components/AskPanel.svelte';
  import CodeView from './components/CodeView.svelte';
  import Landing from './components/Landing.svelte';
  import Legend from './components/Legend.svelte';
  import LinerNotes from './components/LinerNotes.svelte';
  import MobileTabs, { type Tab } from './components/MobileTabs.svelte';
  import NowPlayingSummary from './components/NowPlayingSummary.svelte';
  import PullPad from './components/PullPad.svelte';
  import ReactionDock from './components/ReactionDock.svelte';
  import RecordView from './components/Record.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import StageMeta from './components/StageMeta.svelte';
  import TopBar from './components/TopBar.svelte';
  import VoteCard from './components/VoteCard.svelte';

  // The room and settings are created once by App and never replaced.
  const { room, settings }: { room: Room; settings: Writable<Settings> } = $props();
  // svelte-ignore state_referenced_locally
  const { engine, stores, actions, clock } = room;
  const pulse = startPulse(engine, clock.ready);
  const bar = pulse.bar;
  const { schedule, crowd, connection } = stores;

  const wide = mediaQuery('(min-width: 1200px)');
  const mid = mediaQuery('(min-width: 820px)');
  const layout = derived([wide, mid], ([w, m]): Layout => (w ? 'desktop' : m ? 'tablet' : 'phone'));
  const reduced = mediaQuery('(prefers-reduced-motion: reduce)');
  // svelte-ignore state_referenced_locally
  const calm = derived([settings, reduced], ([s, r]) => s.calm ?? r);
  const engineState = readable(engine.state, (set) => engine.on('state', set));
  const partErrors = writable<Record<string, PartError>>({});
  // Subscribed from the start: parts that fail to compile report it before anyone looks.
  const offErrors = engine.on('partError', (e) => {
    // Late schedule changes aren't the part's fault; everything else mutes that instance.
    if (e.code === 'late-schedule' || !e.partId) return;
    partErrors.update((all) => ({ ...all, [`${e.sectionId}:${e.partId}`]: e }));
  });
  const mutes = writable(new Set<string>());
  // svelte-ignore state_referenced_locally
  provideRoom({ room, pulse, settings, layout, engineState, calm, partErrors, mutes });

  let entered = $state(false);
  /** The landing → room view transition; its overlay swallows input until it finishes. */
  let entering = $state(false);
  let tab = $state<Tab>('pull');
  let settingsOpen = $state(false);
  let audioProblem = $state<string | null>(null);
  let needsGesture = $state(false);
  let main = $state<HTMLElement>();
  let dock = $state<{ press(index: number): void }>();
  let summary = $state<{ show(): void }>();

  const offGesture = engine.on('needsGesture', () => (needsGesture = true));
  onDestroy(() => {
    offGesture();
    offErrors();
    pulse.stop();
    room.destroy();
  });

  // Decode the current section's sounds while the listener reads the landing page.
  engine.prepare().catch(() => {});

  $effect(() => {
    engine.setVolume($settings.volume);
    actions.poke();
  });

  $effect(() => {
    if ($engineState === 'running') needsGesture = false;
  });

  // Titles widen as the music heats up: the needle's intensity when the room reports it, else the
  // track's measured intensity. Written once a bar; CSS eases it over a bar.
  $effect(() => {
    const b = $bar;
    if (!Number.isFinite(b)) return;
    const np = nowPlaying($schedule, b);
    const energy = $crowd ? ($crowd.needle.y + 1) / 2 : np.intensity;
    document.documentElement.style.setProperty('--energy', Math.min(1, Math.max(0, energy)).toFixed(3));
  });

  const np = $derived(nowPlaying($schedule, Number.isFinite($bar) ? $bar : 0));

  // Lock-screen metadata, where the platform shows it.
  $effect(() => {
    const s = np.section;
    if (!('mediaSession' in navigator) || !s) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.name,
        artist: 'Claude',
        album: `B-Side · Side ${sideLetter(np.movement?.side ?? 1)}`,
        artwork: [{ src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
      });
      navigator.mediaSession.setActionHandler('pause', () => engine.suspend());
      navigator.mediaSession.setActionHandler('play', () => void engine.unlock().catch(() => {}));
    } catch {
      // Media Session is decoration.
    }
  });

  function unlock(): void {
    // Must stay synchronous up to engine.unlock(): browsers only honour audio resumes in the gesture.
    try {
      engine.unlock().catch(() => (audioProblem = 'This browser can’t play the room. You can still watch and steer.'));
    } catch {
      audioProblem = 'This browser can’t play the room. You can still watch and steer.';
    }
  }

  function enter(): void {
    unlock();
    const go = () => {
      entered = true;
    };
    const vt = (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }).startViewTransition;
    if (vt && !$calm) {
      entering = true;
      vt.call(document, () => flushSync(go)).finished.finally(() => (entering = false));
    } else go();
    void tick().then(() => main?.focus({ preventScroll: true }));
  }

  function resume(): void {
    unlock();
    needsGesture = false;
  }

  const TEXT_ENTRY = 'textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type="range"]):not([type="radio"]):not([type="checkbox"]):not([type="button"])';

  function focusLater(id: string, next?: Tab): void {
    if (next) tab = next;
    void tick().then(() => document.getElementById(id)?.focus());
  }

  function onKey(e: KeyboardEvent): void {
    if (!entered || settingsOpen || !$settings.shortcuts || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(TEXT_ENTRY)) return;
    const n = ['1', '2', '3', '4'].indexOf(e.key);
    if (n >= 0) {
      e.preventDefault();
      dock?.press(n);
      return;
    }
    switch (e.key) {
      case '?':
        e.preventDefault();
        summary?.show();
        break;
      case 'p':
      case 'P':
        e.preventDefault();
        focusLater('pull-x', 'pull');
        break;
      case 'v':
      case 'V':
        e.preventDefault();
        focusLater('vote-legend', 'vote');
        break;
      case '/':
        e.preventDefault();
        focusLater('ask-input', 'ask');
        break;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="app"
  data-mode={entered ? 'room' : 'landing'}
  data-entering={entering}
  data-layout={$layout}
  data-tab={tab}
  data-calm={$calm}
  data-engine-state={$engineState}
  data-connection={$connection}
>
  {#if entered}
    <a class="skip" href="#pull-x" onclick={(e) => (e.preventDefault(), focusLater('pull-x', 'pull'))}>Skip to the pull pad</a>
    <TopBar onsettings={() => (settingsOpen = true)} />
  {/if}

  <main class="main" bind:this={main} tabindex="-1" aria-label={entered ? 'The listening room' : 'B-Side'}>
    {#if !entered}
      <Landing onenter={enter} />
    {:else}
      <aside class="rail rail-left" id="panel-code" aria-label="Claude’s liner notes and code">
        <LinerNotes />
        <CodeView />
      </aside>
    {/if}

    <section class="stage" aria-label="The record">
      <RecordView {entered} />
      {#if entered}
        <StageMeta />
        <Legend />
        <NowPlayingSummary bind:this={summary} />
      {/if}
    </section>

    {#if entered}
      {#if $layout === 'tablet'}
        <div class="tabs-tablet"><MobileTabs bind:tab /></div>
      {/if}
      <aside class="rail rail-right" aria-label="Steer the music">
        <PullPad />
        <VoteCard />
        <AskPanel />
      </aside>
    {/if}
  </main>

  {#if entered}
    <nav class="dock" aria-label="React to the music">
      {#if needsGesture || audioProblem}
        <div class="notice" role="status">
          {#if needsGesture}
            <span>Sound paused by your device.</span>
            <button type="button" class="notice-btn" onclick={resume}>Tap to resume</button>
          {:else}
            <span>{audioProblem}</span>
          {/if}
        </div>
      {/if}
      {#if $layout === 'phone'}
        <MobileTabs bind:tab />
      {/if}
      <ReactionDock bind:this={dock} />
    </nav>
  {/if}

  <SettingsDialog bind:open={settingsOpen} />
</div>

<style>
  .app {
    min-height: 100dvh;
    background:
      radial-gradient(120vmax 80vmax at 50% 120%, rgb(40 30 52 / 0.35), transparent 60%),
      var(--lacquer-0);
  }

  .skip {
    position: absolute;
    left: var(--s-3);
    top: -100px;
    z-index: 50;
    padding: var(--s-2) var(--s-3);
    background: var(--paper);
    color: var(--lacquer-0);
    border-radius: var(--r-sm);
    font-size: var(--t-sm);
    font-weight: 600;
    text-decoration: none;
  }
  .skip:focus {
    top: var(--s-3);
  }

  .main {
    outline: none;
    overflow-anchor: none;
  }

  .stage {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  /* Positioned so visually hidden live regions inside stay inside the rail's scroll box. */
  .rail {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  /* ─── Landing ───────────────────────────────────────────────────────────────────────────── */

  .app[data-mode='landing'] .main {
    min-height: 100dvh;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    align-items: center;
    gap: clamp(24px, 4vw, 64px);
    padding: clamp(24px, 4vw, 64px) clamp(16px, 5vw, 88px);
  }
  .app[data-mode='landing'] .stage {
    grid-column: 2;
    grid-row: 1;
    justify-content: center;
    align-items: center;
  }

  /* ─── Room: desktop, the whole room in one viewport ───────────────────────────────────── */

  .app[data-mode='room'] {
    height: 100dvh;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
  }
  .app[data-mode='room'] .main {
    display: grid;
    grid-template-columns: minmax(320px, 400px) minmax(0, 1fr) minmax(280px, 340px);
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
  }
  .app[data-mode='room'] .rail {
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--groove) transparent;
  }
  .app[data-mode='room'] .rail-left {
    border-right: 1px solid var(--groove);
  }
  .app[data-mode='room'] .rail-right {
    border-left: 1px solid var(--groove);
  }
  .app[data-mode='room'] .stage {
    padding: var(--s-4) var(--s-5) var(--s-3);
    background: radial-gradient(closest-side, rgb(24 19 31 / 0.9), transparent 100%);
  }

  .dock {
    position: relative;
    border-top: 1px solid var(--groove);
    background: rgb(7 6 10 / 0.92);
    backdrop-filter: blur(12px);
    padding: var(--s-2) var(--gutter) calc(var(--s-2) + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    z-index: 5;
  }

  .notice {
    display: flex;
    gap: var(--s-3);
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    font-size: var(--t-sm);
    color: var(--clay-2);
    text-align: center;
  }
  .notice-btn {
    min-height: 36px;
    padding: 0 var(--s-4);
    border-radius: var(--r-pill);
    background: var(--clay);
    color: var(--clay-ink);
    font-weight: 700;
  }

  /* ─── Tablet: record left, one tabbed rail ────────────────────────────────────────────── */

  .app[data-mode='room'][data-layout='tablet'] .main {
    grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      'stage tabs'
      'stage panel';
  }
  .app[data-mode='room'][data-layout='tablet'] .stage {
    grid-area: stage;
  }
  .tabs-tablet {
    grid-area: tabs;
    padding: var(--s-3) var(--s-4) 0;
    border-left: 1px solid var(--groove);
  }
  .app[data-mode='room'][data-layout='tablet'] .rail {
    grid-area: panel;
    border-left: 1px solid var(--groove);
    border-right: 0;
  }

  /* ─── Phone: record on top, one panel, dock in the thumb zone ─────────────────────────── */

  .app[data-mode='room'][data-layout='phone'] {
    height: auto;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  .app[data-mode='room'][data-layout='phone'] .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    grid-template-columns: none;
  }
  .app[data-mode='room'][data-layout='phone'] .stage {
    order: -1;
    padding: var(--s-2) 0 0;
    background: none;
  }
  .app[data-mode='room'][data-layout='phone'] .rail {
    overflow: visible;
    border: 0;
  }
  .app[data-layout='phone'] .dock {
    position: sticky;
    bottom: 0;
    gap: 6px;
    padding: 6px var(--gutter) calc(6px + env(safe-area-inset-bottom));
  }

  /* One panel at a time below desktop. */
  .app[data-mode='room']:not([data-layout='desktop']):not([data-tab='code']) .rail-left,
  .app[data-mode='room']:not([data-layout='desktop'])[data-tab='code'] .rail-right {
    display: none;
  }
  .app:not([data-layout='desktop'])[data-tab='pull'] .rail-right :global([data-panel]:not([data-panel='pull'])),
  .app:not([data-layout='desktop'])[data-tab='vote'] .rail-right :global([data-panel]:not([data-panel='vote'])),
  .app:not([data-layout='desktop'])[data-tab='ask'] .rail-right :global([data-panel]:not([data-panel='ask'])) {
    display: none;
  }

  @media (max-width: 819.98px) {
    .app[data-mode='landing'] .main {
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
      gap: var(--s-2);
      padding: var(--s-3) var(--gutter) var(--s-8);
    }
    .app[data-mode='landing'] .stage {
      grid-column: 1;
      grid-row: 1;
    }
  }
</style>
