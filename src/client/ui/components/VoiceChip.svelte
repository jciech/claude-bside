<script lang="ts">
  import { ROLE_FAMILY } from '../../../shared/music.ts';
  import type { ProgramPart } from '../../../shared/program.ts';
  import { useRoom } from '../context.ts';
  import type { PartState } from '../now.ts';
  import VoiceGlyph from './VoiceGlyph.svelte';

  let { part, instance, state, barsToEnter, error }: { part: ProgramPart; instance: string; state: PartState; barsToEnter: number; error: string | null } = $props();
  const { pulse, mutes, room } = useRoom();
  const meter = pulse.meter;

  const family = $derived(ROLE_FAMILY[part.role]);
  const muted = $derived($mutes.has(part.id));
  const stateText = $derived(
    error ? `muted by an error: ${error}` : state === 'waiting' ? `enters in ${barsToEnter} bar${barsToEnter === 1 ? '' : 's'}` : state === 'leaving' || state === 'gone' ? 'leaving' : 'playing',
  );

  function toggle(): void {
    const next = new Set($mutes);
    if (muted) next.delete(part.id);
    else next.add(part.id);
    room.engine.setLocalMute(part.id, !muted);
    mutes.set(next);
  }
</script>

<li>
  <button
    type="button"
    class="chip"
    class:waiting={state === 'waiting'}
    class:leaving={state === 'leaving' || state === 'gone'}
    class:error={!!error}
    class:muted
    style:--vc="var(--v-{family})"
    aria-pressed={muted}
    aria-label="{part.id}, {part.instrument}, {stateText}. {muted ? 'Muted in your mix' : 'Mute in your mix'}"
    title="{part.instrument} — {muted ? 'unmute' : 'mute'} in your mix"
    onclick={toggle}
  >
    <span class="swatch" use:meter={instance}><VoiceGlyph {family} size={9} /></span>
    <span class="name">{part.id}</span>
    {#if state === 'waiting'}<span class="aside num">in {barsToEnter}</span>{/if}
    {#if error}<span class="aside" aria-hidden="true">!</span>{/if}
    {#if muted}
      <svg class="mute" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5h2L7 2v8L4 7.5H2zM8.5 4.5l3 3M11.5 4.5l-3 3" /></svg>
    {/if}
  </button>
</li>

<style>
  li {
    flex: none;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 32px;
    padding: 0 11px 0 9px;
    border-radius: var(--r-pill);
    border: 1px solid var(--groove);
    background: rgb(14 12 18 / 0.78);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-2);
    transition:
      opacity var(--env-swell),
      border-color var(--env-pluck),
      background-color var(--env-hit);
  }
  .chip:hover {
    border-color: var(--edge);
    color: var(--paper);
  }
  .swatch {
    color: var(--vc);
    opacity: calc(0.4 + var(--m, 0.5) * 0.6);
    transition: opacity 90ms linear;
  }
  .name {
    color: var(--paper);
  }
  .aside {
    color: var(--paper-3);
    text-transform: none;
    letter-spacing: 0;
  }
  .waiting {
    border-style: dashed;
    opacity: 0.72;
  }
  .leaving .name,
  .muted .name {
    text-decoration: line-through;
    text-decoration-color: var(--paper-3);
  }
  .leaving {
    opacity: 0.55;
  }
  .muted {
    background: transparent;
  }
  .muted .swatch {
    opacity: 0.3;
  }
  .error {
    border-style: dashed;
    border-color: var(--clay-2);
  }
  .error .aside {
    color: var(--clay-2);
    font-weight: 700;
  }
  .mute {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--paper-2);
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
