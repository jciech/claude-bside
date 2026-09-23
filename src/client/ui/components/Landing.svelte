<script lang="ts">
  import { onMount } from 'svelte';
  import { useRoom } from '../context.ts';
  import { sideLetter } from '../format.ts';
  import { nowPlaying } from '../now.ts';

  let { onenter }: { onenter: () => void } = $props();
  const { room, pulse } = useRoom();
  const { schedule, crowd, connection } = room.stores;
  const bar = pulse.bar;

  const np = $derived(nowPlaying($schedule, Number.isFinite($bar) ? $bar : 0));
  let progress = $state(0);

  // The hairline under the button: how much of what's playing has been fetched and decoded.
  onMount(() => {
    const id = setInterval(() => {
      const p = room.engine.preloadProgress();
      progress = p.total > 0 ? p.loaded / p.total : room.engine.state === 'ready' ? 1 : progress;
    }, 250);
    return () => clearInterval(id);
  });

  const eyebrow = $derived(
    $connection === 'full'
      ? 'The room is full right now'
      : $connection === 'offline'
        ? 'The room is offline · retrying'
        : $connection === 'live'
          ? `Live now · ${$crowd?.listeners ?? 1} in the room`
          : 'Tuning in…',
  );
</script>

<div class="landing">
  <p class="eyebrow">
    <span class="live" class:off={$connection !== 'live'} aria-hidden="true"></span>
    <span class="num">{eyebrow}</span>
  </p>
  <h1 class="wordmark">
    <span class="claude">Claude</span>
    <span class="bside">B&#8209;Side</span>
  </h1>
  <p class="lede">
    A record Claude is cutting live, right now. You’re in the room: pull the mood, ask for things, vote on what comes next.
  </p>
  {#if np.section}
    <p class="cutting">
      Now cutting: <strong>Side {sideLetter(np.movement?.side ?? 1)}, Track {np.section.track}</strong>
      <span class="name">“{np.section.name}”</span>
    </p>
  {:else}
    <p class="cutting">Waiting for the first track…</p>
  {/if}
  <div class="cta">
    <button type="button" class="needle" onclick={onenter} disabled={$connection === 'full'}>
      <span class="disc" aria-hidden="true"></span>
      Drop the needle
    </button>
    <div class="hairline" role="progressbar" aria-label="Sounds loaded" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <span style:transform="scaleX({progress})"></span>
    </div>
  </div>
  <p class="hint">Sound starts on the next bar. Headphones recommended.</p>
</div>

<style>
  .landing {
    grid-column: 1;
    grid-row: 1;
    max-width: 38rem;
    display: grid;
    justify-items: start;
    align-content: center;
  }
  .eyebrow {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--t-xs);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--paper-2);
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
      box-shadow: 0 0 0 10px rgb(226 124 92 / 0);
    }
  }
  .wordmark {
    display: grid;
    margin: 20px 0 24px;
    font-family: var(--f-display);
    font-size: var(--t-2xl);
    line-height: 0.86;
    text-transform: uppercase;
    letter-spacing: -0.01em;
  }
  .claude {
    font-weight: 850;
    font-stretch: 58%;
    color: var(--paper);
  }
  .bside {
    font-weight: 250;
    font-stretch: 150%;
    color: var(--clay);
    letter-spacing: 0.01em;
  }
  .lede {
    font-family: var(--f-voice);
    font-style: italic;
    font-size: var(--t-md);
    line-height: 1.5;
    color: var(--paper-2);
    max-width: 30rem;
  }
  .cutting {
    margin: 22px 0 28px;
    font-size: var(--t-sm);
    color: var(--paper-2);
    line-height: 1.6;
  }
  .cutting strong {
    color: var(--paper);
    font-weight: 600;
  }
  .cutting .name {
    font-family: var(--f-display);
    font-weight: 700;
    font-stretch: 90%;
    font-size: 1.05rem;
    color: var(--paper);
    margin-left: 4px;
  }
  .cta {
    display: grid;
    gap: 10px;
    justify-items: stretch;
  }
  .needle {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    min-height: 58px;
    padding: 0 30px 0 16px;
    border-radius: var(--r-pill);
    background: var(--clay);
    color: var(--clay-ink);
    font-family: var(--f-display);
    font-weight: 750;
    font-stretch: 112%;
    font-size: 1.15rem;
    letter-spacing: 0.01em;
    box-shadow:
      0 0 0 1px rgb(242 164 136 / 0.3),
      0 18px 40px -18px rgb(226 124 92 / 0.8);
    transition:
      transform var(--env-hit),
      background-color var(--env-hit),
      box-shadow 300ms ease;
  }
  .needle:hover {
    background: var(--clay-2);
  }
  .needle:active {
    transform: scale(0.97);
  }
  .needle:disabled {
    background: var(--lacquer-3);
    color: var(--paper-3);
    box-shadow: none;
  }
  .disc {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 58% 45%, var(--clay) 0 2.2px, transparent 2.7px),
      radial-gradient(circle, #ece2cc 0 6px, transparent 6.5px),
      repeating-radial-gradient(circle, #1b0c06 0 1px, #3a1b12 1px 2.6px);
    box-shadow: 0 0 0 1px rgb(42 18 10 / 0.5);
  }
  .needle:hover .disc {
    animation: turn 2s linear infinite;
  }
  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }
  .hairline {
    height: 1px;
    background: var(--groove);
    overflow: hidden;
    margin-inline: 20px;
  }
  .hairline span {
    display: block;
    height: 100%;
    background: var(--clay-2);
    transform-origin: left;
    transition: transform 400ms ease;
  }
  .hint {
    margin-top: 14px;
    font-size: var(--t-xs);
    color: var(--paper-3);
  }

  @media (max-width: 819.98px) {
    .landing {
      grid-row: 2;
      justify-items: stretch;
      padding-top: var(--s-2);
    }
    .wordmark {
      margin: 12px 0 14px;
    }
    .cutting {
      margin: 14px 0 20px;
    }
    .needle {
      justify-content: center;
    }
  }
</style>
