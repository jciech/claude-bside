<script lang="ts">
  import { onMount } from 'svelte';
  import { RATE_LIMITS } from '../../../shared/music.ts';
  import type { RequestCard, RequestStatus } from '../../../shared/protocol.ts';
  import { useRoom } from '../context.ts';
  import { TokenBucket } from '../cooldown.ts';
  import { REQUEST_FINAL, REQUEST_STATUS_LABEL, requestErrorText } from '../format.ts';

  const MAX = 140;
  const { room } = useRoom();
  const { requests, crowd } = room.stores;

  const bucket = new TokenBucket(RATE_LIMITS.request, performance.now());
  let text = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);
  let waitS = $state(0);
  let pending = $state<{ id: string; text: string } | null>(null);
  let announced = $state('');
  const seen = new Map<string, RequestStatus>();

  onMount(() => {
    const id = setInterval(() => (waitS = Math.ceil(bucket.waitMs(performance.now()) / 1000)), 500);
    return () => clearInterval(id);
  });

  const cards = $derived.by(() => {
    const list = [...$requests];
    if (pending && !list.some((c) => c.id === pending!.id)) {
      list.unshift({ id: pending.id, mine: true, text: pending.text, status: 'received', supporters: 1, publicReply: null, sectionId: null, createdAt: Date.now() });
    }
    const mine = list.filter((c) => c.mine).sort((a, b) => b.createdAt - a.createdAt);
    const others = list.filter((c) => !c.mine && c.publicReply).sort((a, b) => b.createdAt - a.createdAt);
    return [...mine.slice(0, 5), ...others.slice(0, 8)];
  });

  // Your own requests' status changes are announced (politely), nobody else's.
  $effect(() => {
    for (const c of $requests) {
      if (!c.mine) continue;
      const before = seen.get(c.id);
      if (before && before !== c.status) announced = `Your ask “${c.text ?? ''}”: ${REQUEST_STATUS_LABEL[c.status]}${c.publicReply ? `. Claude: ${c.publicReply}` : ''}`;
      seen.set(c.id, c.status);
    }
  });

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    if (!bucket.take(performance.now())) {
      error = requestErrorText('rate-limited');
      return;
    }
    sending = true;
    error = null;
    const res = await room.actions.request(value);
    sending = false;
    if (res.ok) {
      pending = { id: res.id, text: value };
      seen.set(res.id, 'received');
      announced = 'Sent. Claude will weigh it at the next decision.';
      text = '';
    } else {
      error = requestErrorText(res.error);
    }
  }

  const tone = (s: RequestStatus): string => (s === 'playing' ? 'playing' : s === 'planned' || s === 'next-movement' || s === 'fork-option' ? 'coming' : REQUEST_FINAL.has(s) ? 'done' : 'open');
  const quote = (c: RequestCard): string | null => (c.mine ? c.text : c.publicReply);
</script>

<section class="asks" id="panel-ask" data-panel="ask" aria-labelledby="ask-h">
  <h2 id="ask-h" class="rail-h">Ask Claude {#if $crowd}<span class="sub num">{$crowd.requestsWaiting} waiting</span>{/if}</h2>

  <form class="form" onsubmit={submit}>
    <label for="ask-input" class="sr-only">Ask Claude for a sound, a feeling or a change</label>
    <div class="field">
      <input
        id="ask-input"
        type="text"
        maxlength={MAX}
        autocomplete="off"
        enterkeyhint="send"
        placeholder="A sound, a feeling, a change…"
        aria-describedby="ask-count ask-note"
        bind:value={text}
        oninput={() => (error = null)}
      />
      <span id="ask-count" class="count num" class:near={text.length > MAX - 20} class:empty={!text}>{text.length}/{MAX}</span>
    </div>
    <button type="submit" class="send" disabled={!text.trim() || sending || waitS > 0}>
      {sending ? 'Sending…' : waitS > 0 ? `${waitS} s` : 'Send'}
    </button>
  </form>
  <p id="ask-note" class="note">{error ?? 'Only you see your words. Everyone else sees Claude’s take on them.'}</p>

  {#if cards.length}
    <ol class="list">
      {#each cards as c (c.id)}
        <li class="card {tone(c.status)}" class:mine={c.mine}>
          <span class="status">{REQUEST_STATUS_LABEL[c.status]}</span>
          {#if quote(c)}<q>{quote(c)}</q>{/if}
          <span class="who">
            {#if c.mine}you{c.supporters > 1 ? ` + ${c.supporters - 1}` : ''}{:else if c.supporters > 1}{c.supporters} asked{/if}
            {#if c.mine && c.publicReply}<span class="reply">Claude: {c.publicReply}</span>{/if}
          </span>
        </li>
      {/each}
    </ol>
  {/if}
  <p class="sr-only" aria-live="polite">{announced}</p>
</section>

<style>
  .asks {
    padding: var(--s-4) var(--s-5) var(--s-6);
    border-top: 1px solid var(--groove);
  }
  .rail-h {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
    margin-bottom: var(--s-3);
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
  .form {
    display: flex;
    gap: var(--s-2);
  }
  .field {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  input {
    width: 100%;
    min-height: 44px;
    padding: 0 52px 0 12px;
    border-radius: var(--r-sm);
    border: 1px solid var(--edge);
    background: var(--lacquer-1);
    font-size: var(--t-sm);
  }
  input::placeholder {
    color: var(--paper-3);
  }
  input:focus-visible {
    outline-offset: 2px;
  }
  .count {
    position: absolute;
    right: 10px;
    top: 50%;
    translate: 0 -50%;
    font-size: 10px;
    color: var(--paper-3);
    pointer-events: none;
  }
  .count.near {
    color: var(--clay-2);
  }
  .count.empty {
    opacity: 0;
  }
  .send {
    min-height: 44px;
    min-width: 72px;
    padding: 0 var(--s-4);
    border-radius: var(--r-sm);
    background: var(--paper);
    color: var(--lacquer-0);
    font-weight: 650;
    font-size: var(--t-sm);
    transition: transform var(--env-hit);
  }
  .send:active:not(:disabled) {
    transform: scale(0.97);
  }
  .send:disabled {
    background: var(--lacquer-3);
    color: var(--paper-3);
  }
  .note {
    margin-top: 6px;
    font-size: var(--t-xs);
    color: var(--paper-3);
  }
  .list {
    display: grid;
    gap: var(--s-3);
    margin-top: var(--s-4);
  }
  .card {
    display: grid;
    gap: 2px;
    padding-left: 12px;
    border-left: 2px solid var(--groove);
    font-size: var(--t-sm);
  }
  .card q {
    color: var(--paper);
    overflow-wrap: anywhere;
  }
  .status {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-3);
  }
  .coming {
    border-left-color: var(--clay-2);
  }
  .coming .status {
    color: var(--clay-2);
  }
  .playing {
    border-left-color: var(--clay);
  }
  .playing .status {
    color: var(--clay);
    font-weight: 700;
  }
  .done q {
    color: var(--paper-2);
  }
  .mine {
    border-left-style: solid;
  }
  .who {
    font-size: var(--t-xs);
    color: var(--paper-3);
  }
  .reply {
    display: block;
    margin-top: 2px;
    color: var(--clay-2);
  }
  :global([data-layout='phone']) .asks {
    padding: var(--s-3) var(--gutter) var(--s-4);
    border-top: 0;
  }
</style>
