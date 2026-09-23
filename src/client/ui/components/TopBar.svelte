<script lang="ts">
  import { useRoom } from '../context.ts';
  import { bpmOf, scaleLabel, sideLetter } from '../format.ts';
  import { nowPlaying } from '../now.ts';
  import BrandMark from './BrandMark.svelte';

  let { onsettings }: { onsettings: () => void } = $props();
  const { room, pulse, settings, layout } = useRoom();
  const { schedule, crowd, connection } = room.stores;
  const bar = pulse.bar;

  const cycle = $derived(Number.isFinite($bar) ? $bar : 0);
  const np = $derived(nowPlaying($schedule, cycle));
  const bpm = $derived(Number.isFinite($bar) ? bpmOf(room.engine.cps()) : 120);
  const side = $derived(sideLetter(np.movement?.side ?? 1));
  // Announced once per track, not every bar.
  const announce = $derived(np.section ? `Now playing: ${np.section.name}, track ${np.section.track} of side ${side}.` : '');

  let lastVolume = 0.8;
  function toggleMute(): void {
    settings.update((s) => {
      if (s.volume > 0) {
        lastVolume = s.volume;
        return { ...s, volume: 0 };
      }
      return { ...s, volume: lastVolume || 0.8 };
    });
  }
</script>

<header class="top">
  <div class="brand">
    <BrandMark size={26} />
    <span class="wordmark">B&#8209;Side</span>
  </div>

  <div class="now">
    {#if np.section}
      <span class="side meta">Side {side} · Track {np.section.track}</span>
      <span class="title" title={np.section.name}>{np.section.name}</span>
      <span class="facts num">{bpm} bpm · {scaleLabel(np.section.scale)} · bar {cycle}</span>
    {:else}
      <span class="title quiet">— listening —</span>
    {/if}
    <span class="sr-only" aria-live="polite">{announce}</span>
  </div>

  <div class="tools">
    {#if $layout !== 'phone'}
      <p class="presence" title="Listeners in the room right now">
        <span class="live" class:off={$connection !== 'live'} aria-hidden="true"></span>
        <span class="num">{$crowd?.listeners ?? '—'}</span><span class="sub">listening</span>
      </p>
      <div class="volume">
        <button type="button" class="icon" onclick={toggleMute} aria-label={$settings.volume > 0 ? 'Mute' : 'Unmute'}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" />
            {#if $settings.volume > 0}
              <path d="M15.5 9a4 4 0 0 1 0 6" class="stroke" />
              {#if $settings.volume > 0.5}<path d="M18 6.5a7.5 7.5 0 0 1 0 11" class="stroke" />{/if}
            {:else}
              <path d="M16 9.5l5 5M21 9.5l-5 5" class="stroke" />
            {/if}
          </svg>
        </button>
        <input type="range" min="0" max="1" step="0.05" aria-label="Volume" aria-valuetext="{Math.round($settings.volume * 100)}%" bind:value={$settings.volume} />
      </div>
    {/if}
    <button type="button" class="icon" onclick={onsettings} aria-label="Settings" aria-haspopup="dialog">
      <svg viewBox="0 0 24 24" aria-hidden="true" class="stroke">
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </svg>
    </button>
  </div>
</header>

<style>
  .top {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: var(--s-4);
    padding: 10px var(--s-5);
    border-bottom: 1px solid var(--groove);
    min-height: 56px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .wordmark {
    font-family: var(--f-display);
    font-weight: 800;
    font-stretch: 72%;
    font-size: 1.3rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    line-height: 1;
  }
  .now {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 14px;
    min-width: 0;
    white-space: nowrap;
  }
  .side {
    color: var(--paper-2);
  }
  .title {
    font-family: var(--f-display);
    font-weight: 700;
    font-stretch: calc(70% + var(--energy) * 60%);
    font-size: 1.2rem;
    line-height: 1;
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: font-stretch var(--env-swell);
  }
  .title.quiet {
    font-family: var(--f-voice);
    font-style: italic;
    font-weight: 400;
    color: var(--paper-2);
  }
  .facts {
    font-size: var(--t-xs);
    color: var(--paper-3);
  }
  .tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--s-3);
  }
  .presence {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: var(--t-sm);
    color: var(--paper);
  }
  .presence .sub {
    color: var(--paper-3);
  }
  .live {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--clay);
    animation: live 2.4s var(--ease-swell) infinite;
  }
  .live.off {
    background: var(--paper-3);
    animation: none;
  }
  @keyframes live {
    0% {
      box-shadow: 0 0 0 0 rgb(226 124 92 / 0.55);
    }
    70%,
    100% {
      box-shadow: 0 0 0 9px rgb(226 124 92 / 0);
    }
  }
  .volume {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .volume input {
    width: 88px;
    accent-color: var(--paper);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--r-sm);
    color: var(--paper-2);
  }
  .icon:hover {
    color: var(--paper);
    background: var(--lacquer-3);
  }
  svg {
    width: 20px;
    height: 20px;
    fill: currentColor;
  }
  .stroke,
  svg :global(.stroke) {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  :global([data-layout='tablet']) .top {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  :global([data-layout='tablet']) .side,
  :global([data-layout='tablet']) .facts {
    display: none;
  }
  :global([data-layout='phone']) .top {
    grid-template-columns: auto minmax(0, 1fr) auto;
    padding: 6px var(--s-2) 6px var(--gutter);
    min-height: 52px;
    gap: var(--s-3);
  }
  :global([data-layout='phone']) .wordmark {
    font-size: 1.1rem;
  }
  :global([data-layout='phone']) .now {
    justify-content: flex-end;
  }
  :global([data-layout='phone']) .side,
  :global([data-layout='phone']) .facts {
    display: none;
  }
  :global([data-layout='phone']) .title {
    font-size: 1.05rem;
    max-width: 100%;
  }
</style>
