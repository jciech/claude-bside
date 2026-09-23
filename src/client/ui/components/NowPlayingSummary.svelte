<script lang="ts">
  // The record's text alternative: what is playing, in words. Visually hidden until someone asks
  // for it with "?" — then it opens as a card for sighted keyboard users too.
  import { tick } from 'svelte';
  import { useRoom } from '../context.ts';
  import { bpmOf, cueText, scaleLabel, sideLetter } from '../format.ts';
  import { nowPlaying, summaryLines } from '../now.ts';

  const { room, pulse, mutes } = useRoom();
  const { schedule, notes } = room.stores;
  const bar = pulse.bar;

  let shown = $state(false);
  let el = $state<HTMLElement>();

  export async function show(): Promise<void> {
    shown = true;
    await tick();
    el?.focus();
  }

  const cycle = $derived(Number.isFinite($bar) ? $bar : 0);
  const np = $derived(nowPlaying($schedule, cycle));
  const parts = $derived(summaryLines($schedule, cycle, $mutes));
  const latest = $derived($notes[$notes.length - 1] ?? null);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape and focus-out close the opened card) -->
<section
  class="summary"
  class:shown
  id="now-playing"
  bind:this={el}
  tabindex="-1"
  aria-labelledby="summary-h"
  onfocusout={(e) => {
    if (!el?.contains(e.relatedTarget as Node | null)) shown = false;
  }}
  onkeydown={(e) => e.key === 'Escape' && (shown = false)}
>
  <h2 id="summary-h">What’s playing</h2>
  {#if np.section}
    <p>
      Side {sideLetter(np.movement?.side ?? 1)}, track {np.section.track}: “{np.section.name}”, a {np.section.role}.
      {bpmOf(room.engine.cps())} BPM in {scaleLabel(np.section.scale)}, bar {cycle}.
      {#if np.next && np.barsToNext !== null}Next: {cueText(np.next.role, np.barsToNext)}{np.next.provisional ? ' (planned)' : ''}.{/if}
    </p>
    <ul>
      {#each parts as line (line.key)}<li>{line.text}</li>{/each}
    </ul>
  {:else}
    <p>Nothing is playing right now — the room is listening.</p>
  {/if}
  {#if latest}<p>Claude’s latest note: {latest.text}</p>{/if}
  <button type="button" class="close" onclick={() => (shown = false)}>Close</button>
</section>

<style>
  .summary:not(.shown) {
    position: absolute !important;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .summary.shown {
    position: absolute;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    z-index: 20;
    width: min(92%, 440px);
    max-height: 80%;
    overflow: auto;
    padding: var(--s-5);
    border-radius: var(--r-md);
    background: var(--lacquer-2);
    border: 1px solid var(--edge);
    box-shadow: 0 24px 64px rgb(0 0 0 / 0.6);
    font-size: var(--t-sm);
    color: var(--paper-2);
    display: grid;
    gap: var(--s-3);
  }
  h2 {
    font-size: var(--t-xs);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper);
  }
  ul {
    display: grid;
    gap: 2px;
  }
  .close {
    justify-self: end;
    min-height: 36px;
    padding: 0 var(--s-4);
    border-radius: var(--r-sm);
    border: 1px solid var(--edge);
    color: var(--paper);
  }
</style>
