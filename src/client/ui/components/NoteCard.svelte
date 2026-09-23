<script lang="ts">
  import type { LinerNote, RequestCard } from '../../../shared/protocol.ts';

  let { note, current, requests }: { note: LinerNote; current: boolean; requests: RequestCard[] } = $props();

  const AUTHOR: Record<LinerNote['author'], string> = { claude: 'Claude', scripted: 'Autopilot', external: 'Guest composer', room: 'The room' };

  const answers = $derived(
    note.answering
      .map((id) => requests.find((r) => r.id === id))
      .filter((r): r is RequestCard => !!r)
      .map((r) => ({ id: r.id, text: r.mine ? r.text : r.publicReply, mine: r.mine, others: Math.max(0, r.supporters - 1) })),
  );
</script>

<article class="note" class:current class:movement={note.kind === 'movement'} class:system={note.kind === 'system' || note.author === 'room'}>
  <p class="stamp">
    {#if current}<span class="dot" aria-hidden="true"></span>{/if}
    <span>{AUTHOR[note.author]}</span>
    <span aria-hidden="true">·</span>
    <span class="num">bar {Math.floor(note.cycle)}</span>
    {#if note.kind === 'movement'}<span class="tag">new side</span>{:else if note.kind === 'reply'}<span class="tag">reply</span>{/if}
  </p>
  <p class="text">{note.text}</p>
  {#each answers as a (a.id)}
    <p class="ack">
      ↳ answering {#if a.text}<q>{a.text}</q>{:else}a wish from the room{/if}
      {#if a.mine}<span class="who">you{a.others ? ` + ${a.others}` : ''}</span>{:else if a.others}<span class="who">+ {a.others}</span>{/if}
    </p>
  {:else}
    {#if note.answering.length}<p class="ack">↳ answering {note.answering.length === 1 ? 'a wish' : `${note.answering.length} wishes`} from the room</p>{/if}
  {/each}
</article>

<style>
  .note {
    position: relative;
    padding: 2px 0 2px 14px;
    border-left: 2px solid var(--groove);
  }
  .note.current {
    border-left-color: var(--clay);
  }
  .stamp {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--t-xs);
    color: var(--paper-3);
    margin-bottom: 4px;
  }
  .current .stamp {
    color: var(--paper-2);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--clay);
  }
  .tag {
    padding: 0 7px;
    border-radius: var(--r-pill);
    border: 1px solid var(--groove);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-2);
  }
  .text {
    font-family: var(--f-voice);
    font-style: italic;
    font-size: var(--t-base);
    line-height: 1.45;
    color: var(--paper-2);
    overflow-wrap: anywhere;
  }
  .current .text {
    font-size: var(--t-md);
    color: var(--paper);
  }
  .movement .text {
    color: var(--paper);
  }
  .system .text {
    font-family: var(--f-mono);
    font-style: normal;
    font-size: var(--t-sm);
    color: var(--paper-3);
  }
  .ack {
    margin-top: 6px;
    font-size: var(--t-xs);
    color: var(--clay-2);
    overflow-wrap: anywhere;
  }
  .ack q {
    color: var(--paper);
  }
  .who {
    margin-left: 6px;
    color: var(--paper-3);
  }
</style>
