<script lang="ts">
  import { useRoom } from '../context.ts';
  import { DEFAULT_SOURCE_URL } from '../stores.ts';

  let { open = $bindable(false) }: { open: boolean } = $props();
  const { room, settings, calm } = useRoom();
  const { sourceUrl } = room.stores;

  let dialog = $state<HTMLDialogElement>();
  const source = $derived(/^https?:\/\//i.test($sourceUrl) ? $sourceUrl : DEFAULT_SOURCE_URL);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  function setCalm(e: Event): void {
    const on = (e.currentTarget as HTMLInputElement).checked;
    settings.update((s) => ({ ...s, calm: on }));
  }
</script>

<dialog bind:this={dialog} aria-labelledby="settings-h" onclose={() => (open = false)} onclick={(e) => e.target === dialog && (open = false)}>
  <form method="dialog" class="panel">
    <header>
      <h2 id="settings-h">Settings</h2>
      <button type="submit" class="close" aria-label="Close settings">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
      </button>
    </header>

    <label class="row">
      <span class="name">Volume <span class="val num">{Math.round($settings.volume * 100)}%</span></span>
      <input type="range" min="0" max="1" step="0.05" bind:value={$settings.volume} aria-valuetext="{Math.round($settings.volume * 100)}%" />
    </label>

    <label class="row toggle">
      <span class="name">Calm visuals<span class="desc">The record stops spinning; a stylus dot circles instead. No flashes.</span></span>
      <input type="checkbox" role="switch" checked={$calm} onchange={setCalm} />
    </label>

    <label class="row toggle">
      <span class="name">Pause visuals<span class="desc">Stop drawing the record entirely. The music keeps playing.</span></span>
      <input type="checkbox" role="switch" bind:checked={$settings.pauseVisuals} />
    </label>

    <label class="row toggle">
      <span class="name">Keyboard shortcuts<span class="desc">1–4 react · P pull · V vote · / ask · ? what’s playing</span></span>
      <input type="checkbox" role="switch" bind:checked={$settings.shortcuts} />
    </label>

    <p class="source">
      B-Side is free software under the AGPL-3.0, built on <a href="https://strudel.cc" target="_blank" rel="noopener noreferrer">Strudel</a>.
      <a href={source} target="_blank" rel="noopener noreferrer">Source code</a>
    </p>
  </form>
</dialog>

<style>
  dialog {
    margin: auto;
    width: min(440px, calc(100vw - 32px));
    padding: 0;
    border: 1px solid var(--edge);
    border-radius: var(--r-md);
    background: var(--lacquer-2);
    color: var(--paper);
    box-shadow: 0 30px 80px rgb(0 0 0 / 0.6);
  }
  dialog::backdrop {
    background: rgb(7 6 10 / 0.7);
    backdrop-filter: blur(4px);
  }
  .panel {
    display: grid;
    gap: var(--s-4);
    padding: var(--s-5);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    font-family: var(--f-display);
    font-weight: 750;
    font-stretch: 90%;
    font-size: 1.25rem;
  }
  .close {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--r-sm);
    color: var(--paper-2);
  }
  .close:hover {
    background: var(--lacquer-3);
    color: var(--paper);
  }
  .close svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  .row {
    display: grid;
    gap: var(--s-2);
    font-size: var(--t-sm);
  }
  .row.toggle {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-4);
    min-height: 44px;
  }
  .name {
    display: grid;
    gap: 2px;
  }
  .val {
    display: inline;
    color: var(--paper-3);
    margin-left: 6px;
  }
  .desc {
    font-size: var(--t-xs);
    color: var(--paper-3);
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--clay);
  }
  input[type='checkbox'] {
    appearance: none;
    width: 44px;
    height: 26px;
    border-radius: var(--r-pill);
    border: 1px solid var(--edge);
    background: var(--lacquer-1);
    position: relative;
    cursor: pointer;
    transition: background-color var(--env-hit);
  }
  input[type='checkbox']::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--paper-2);
    transition: translate var(--env-hit);
  }
  input[type='checkbox']:checked {
    background: var(--clay);
    border-color: var(--clay);
  }
  input[type='checkbox']:checked::after {
    translate: 18px 0;
    background: var(--clay-ink);
  }
  .source {
    padding-top: var(--s-3);
    border-top: 1px solid var(--groove);
    font-size: var(--t-xs);
    color: var(--paper-3);
    line-height: 1.6;
  }
</style>
