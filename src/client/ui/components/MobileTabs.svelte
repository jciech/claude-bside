<script lang="ts" module>
  export type Tab = 'code' | 'pull' | 'vote' | 'ask';
</script>

<script lang="ts">
  import { useRoom } from '../context.ts';

  let { tab = $bindable() }: { tab: Tab } = $props();
  const { room } = useRoom();
  const { fork, requests } = room.stores;

  // "Code" holds Claude's liner notes too: what it is doing, and why.
  const TABS: { id: Tab; label: string; panel: string }[] = [
    { id: 'code', label: 'Code', panel: 'panel-code' },
    { id: 'pull', label: 'Pull', panel: 'panel-pull' },
    { id: 'vote', label: 'Vote', panel: 'panel-vote' },
    { id: 'ask', label: 'Ask', panel: 'panel-ask' },
  ];

  // A dot on tabs with something waiting: an open vote you haven't answered, your ask moving.
  const pending = $derived<Record<Tab, boolean>>({
    code: false,
    pull: false,
    vote: !!$fork && !$fork.result && !$fork.myVote,
    ask: $requests.some((r) => r.mine && (r.status === 'planned' || r.status === 'playing')),
  });

  function onkeydown(e: KeyboardEvent): void {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    tab = TABS[next]!.id;
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab-id="${tab}"]`)?.focus();
  }
</script>

<div class="tabs" role="tablist" aria-label="Panels" tabindex="-1" {onkeydown}>
  {#each TABS as t (t.id)}
    <button
      type="button"
      role="tab"
      id="tab-{t.id}"
      data-tab-id={t.id}
      aria-selected={tab === t.id}
      aria-controls={t.panel}
      tabindex={tab === t.id ? 0 : -1}
      onclick={() => (tab = t.id)}
    >
      {t.label}
      {#if pending[t.id] && tab !== t.id}<span class="dot" aria-label="(new)"></span>{/if}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    border-radius: var(--r-pill);
    background: var(--lacquer-1);
    border: 1px solid var(--groove);
  }
  button {
    position: relative;
    flex: 1;
    min-height: 38px;
    border-radius: var(--r-pill);
    font-size: var(--t-sm);
    color: var(--paper-2);
    transition:
      background-color var(--env-hit),
      color var(--env-hit);
  }
  button:hover {
    color: var(--paper);
  }
  button[aria-selected='true'] {
    background: var(--paper);
    color: var(--lacquer-0);
    font-weight: 650;
  }
  .dot {
    position: absolute;
    top: 8px;
    right: calc(50% - 26px);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--clay);
  }
</style>
