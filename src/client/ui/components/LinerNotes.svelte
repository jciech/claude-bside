<script lang="ts">
  import { fly } from 'svelte/transition';
  import type { LinerNote } from '../../../shared/protocol.ts';
  import { useRoom } from '../context.ts';
  import NoteCard from './NoteCard.svelte';

  const { room, pulse, calm } = useRoom();
  const { notes, requests, fork } = room.stores;
  const bar = pulse.bar;

  /** Announce Claude's newest note at most once every 8 bars (docs/DESIGN.md accessibility). */
  const ANNOUNCE_EVERY_BARS = 8;

  interface VoteResult {
    id: string;
    cycle: number;
    text: string;
  }
  let results = $state<VoteResult[]>([]);
  let pendingResult: { id: string; text: string } | null = null;
  let announced = $state('');
  let lastAnnouncedId: string | null = null;
  let lastAnnouncedBar = Number.NEGATIVE_INFINITY;

  // A closed vote's winner lands in the notes on the next downbeat.
  $effect(() => {
    const f = $fork;
    if (!f?.result || results.some((r) => r.id === f.id) || pendingResult?.id === f.id) return;
    const option = f.options.find((o) => o.id === f.result!.option);
    const share = Math.round((f.tally[f.result.option] ?? 0) * 100);
    const how = f.result.binding ? 'The room chose' : 'The room leaned toward';
    pendingResult = { id: f.id, text: `${how} ${f.result.option}: ${option?.label ?? ''} (${share}%)${f.myVote === f.result.option ? ' — your pick' : ''}` };
  });

  $effect(() => {
    const b = $bar;
    if (!Number.isFinite(b)) return;
    if (pendingResult) {
      results = [...results, { ...pendingResult, cycle: b }];
      pendingResult = null;
    }
    const newest = $notes[$notes.length - 1];
    if (newest && newest.id !== lastAnnouncedId && b - lastAnnouncedBar >= ANNOUNCE_EVERY_BARS) {
      lastAnnouncedId = newest.id;
      lastAnnouncedBar = b;
      announced = `Claude: ${newest.text}`;
    }
  });

  type Item = { kind: 'note'; note: LinerNote } | { kind: 'vote'; result: VoteResult };
  const items = $derived<Item[]>(
    [...$notes.map((note) => ({ kind: 'note' as const, note, at: note.cycle })), ...results.map((result) => ({ kind: 'vote' as const, result, at: result.cycle }))]
      .sort((a, b) => b.at - a.at)
      .map(({ at: _at, ...item }) => item as Item),
  );
  const newestNoteId = $derived($notes[$notes.length - 1]?.id ?? null);
</script>

<section class="liner" data-panel="code" aria-labelledby="liner-h">
  <h2 id="liner-h" class="rail-h">Liner notes <span class="sub">Claude, as it plays</span></h2>
  {#if items.length}
    <ol class="timeline">
      {#each items as item (item.kind === 'note' ? item.note.id : `vote-${item.result.id}`)}
        <li in:fly={item.kind === 'note' ? { y: -12, duration: $calm ? 0 : 400 } : { x: 80, duration: $calm ? 0 : 700 }}>
          {#if item.kind === 'note'}
            <NoteCard note={item.note} current={item.note.id === newestNoteId} requests={$requests} />
          {:else}
            <p class="vote-result">
              <span class="num">bar {item.result.cycle}</span>
              ↳ {item.result.text}
            </p>
          {/if}
        </li>
      {/each}
    </ol>
  {:else}
    <p class="empty">Claude’s notes on what it’s doing — and why — appear here as the record turns.</p>
  {/if}
  <p class="sr-only" aria-live="polite">{announced}</p>
</section>

<style>
  .liner {
    padding: var(--s-5) var(--s-5) var(--s-4);
  }
  .rail-h {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
    margin-bottom: var(--s-4);
    font-size: var(--t-xs);
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--paper-2);
  }
  .sub {
    font-weight: 400;
    letter-spacing: 0.02em;
    text-transform: none;
    color: var(--paper-3);
  }
  .timeline {
    display: grid;
    gap: var(--s-4);
    max-height: min(46vh, 520px);
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--groove) transparent;
    padding-right: var(--s-1);
  }
  :global([data-layout='phone']) .timeline,
  :global([data-layout='tablet']) .timeline {
    max-height: 36vh;
  }
  .vote-result {
    padding-left: 14px;
    border-left: 2px dashed var(--clay);
    font-size: var(--t-sm);
    color: var(--clay-2);
  }
  .vote-result .num {
    display: block;
    font-size: var(--t-xs);
    color: var(--paper-3);
  }
  .empty {
    font-family: var(--f-voice);
    font-style: italic;
    color: var(--paper-3);
  }
  :global([data-layout='phone']) .liner {
    padding: var(--s-4) var(--gutter) var(--s-3);
  }
</style>
