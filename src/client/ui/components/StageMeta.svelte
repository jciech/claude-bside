<script lang="ts">
  import { useRoom } from '../context.ts';
  import { composerLine, cueText } from '../format.ts';
  import { nowPlaying } from '../now.ts';

  const { room, pulse } = useRoom();
  const { schedule, composer, connection } = room.stores;
  const bar = pulse.bar;

  const np = $derived(nowPlaying($schedule, Number.isFinite($bar) ? $bar : 0));
  // Re-read once a bar, so "decides in ~40 s" counts down with the music.
  const line = $derived($composer && Number.isFinite($bar) ? composerLine($composer, room.clock.serverNow()) : null);
  const planning = $derived($composer?.state === 'planning');
</script>

<div class="meta-row">
  {#if np.next && np.barsToNext !== null}
    <p class="cue" class:soon={np.barsToNext <= 2} class:planned={np.next.provisional} aria-live="off">
      <span class="cue-label">Next</span>
      <span class="cue-text num">{cueText(np.next.role, np.barsToNext)}</span>
      {#if np.next.provisional}<span class="cue-tag" title="Can still change if the room pulls hard">planned</span>{/if}
    </p>
  {:else if np.section}
    <p class="cue"><span class="cue-label">Now</span><span class="cue-text">the band plays on</span></p>
  {/if}

  {#if $connection === 'reconnecting' || $connection === 'offline'}
    <p class="composer warn" role="status"><span class="dot" aria-hidden="true"></span>reconnecting · still playing</p>
  {:else if line}
    <p class="composer" class:planning><span class="dot" aria-hidden="true"></span>{line}</p>
  {/if}
</div>

<style>
  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-4);
    align-items: center;
    justify-content: space-between;
    padding: var(--s-2) 0 var(--s-1);
    min-height: 40px;
  }
  :global([data-layout='phone']) .meta-row {
    flex-wrap: nowrap;
    padding-inline: var(--gutter);
  }
  :global([data-layout='phone']) .cue {
    flex: none;
  }
  :global([data-layout='phone']) .composer {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    display: block;
    font-size: var(--t-xs);
  }
  :global([data-layout='phone']) .composer .dot {
    display: none;
  }
  .cue {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    padding: 5px 12px 5px 10px;
    border-radius: var(--r-pill);
    border: 1px solid var(--groove);
    background: rgb(14 12 18 / 0.7);
    font-size: var(--t-xs);
    color: var(--paper-2);
    transition:
      border-color var(--env-pluck),
      color var(--env-pluck);
  }
  .cue-label {
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-3);
  }
  .cue-text {
    color: var(--paper);
    font-weight: 600;
  }
  .cue.soon {
    border-color: var(--clay);
  }
  .cue.soon .cue-text {
    color: var(--clay-2);
  }
  .cue-tag {
    padding: 1px 7px;
    border-radius: var(--r-pill);
    border: 1px dashed var(--edge);
    color: var(--paper-2);
    font-size: 10px;
    letter-spacing: 0.06em;
  }
  .composer {
    display: inline-flex;
    align-items: baseline;
    gap: var(--s-2);
    font-family: var(--f-voice);
    font-style: italic;
    font-size: var(--t-sm);
    color: var(--clay-2);
    min-width: 0;
  }
  .composer.warn {
    font-family: var(--f-mono);
    font-style: normal;
    font-size: var(--t-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--clay);
    translate: 0 -1px;
  }
  .planning .dot {
    animation: breathe var(--bar) var(--ease-swell) infinite alternate;
  }
  @keyframes breathe {
    from {
      opacity: 0.35;
    }
    to {
      opacity: 1;
    }
  }
</style>
