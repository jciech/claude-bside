<script lang="ts">
  import { useRoom } from '../context.ts';
  import { audibleInstances, partState } from '../now.ts';
  import { scoreBarAt } from '../../../shared/schedule.ts';
  import VoiceChip from './VoiceChip.svelte';

  const { room, pulse, partErrors } = useRoom();
  const { schedule } = room.stores;
  const bar = pulse.bar;

  const chips = $derived.by(() => {
    const cycle = Number.isFinite($bar) ? $bar : 0;
    return audibleInstances($schedule, cycle).map((x) => {
      const score = scoreBarAt(x.section, Math.max(0, cycle - x.section.startCycle));
      const state = x.leaving ? 'leaving' : partState(x.part, cycle < x.section.startCycle ? cycle - x.section.startCycle : score);
      return { ...x, state, barsToEnter: Math.max(1, Math.ceil(x.part.enterBar - score)), error: $partErrors[x.key]?.message ?? null };
    });
  });
</script>

{#if chips.length}
  <ul class="legend" aria-label="Parts playing — press one to mute it in your own mix">
    {#each chips as c (c.key)}
      <VoiceChip part={c.part} instance={c.key} state={c.state} barsToEnter={c.barsToEnter} error={c.error} />
    {/each}
  </ul>
{/if}

<style>
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: var(--s-1) 0 var(--s-2);
  }
  :global([data-layout='phone']) .legend {
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-inline: var(--gutter);
    scrollbar-width: none;
    mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent);
  }
  :global([data-layout='phone']) .legend::-webkit-scrollbar {
    display: none;
  }
</style>
