<script lang="ts">
  import { onMount } from 'svelte';
  import { RATE_LIMITS } from '../../../shared/music.ts';
  import { useRoom } from '../context.ts';
  import { TokenBucket } from '../cooldown.ts';
  import { keepPendingText, nackText } from '../format.ts';
  import { nowPlaying } from '../now.ts';

  const { room, pulse } = useRoom();
  const { actions } = room;
  const { crowd, schedule, nack } = room.stores;
  const bar = pulse.bar;

  type Kind = 'fire' | 'stay' | 'move' | 'harsh';
  const BUTTONS: { kind: Kind; label: string; hint: string }[] = [
    { kind: 'fire', label: 'Yes', hint: 'This works — more moments like this' },
    { kind: 'stay', label: 'Stay', hint: 'Hold this track a little longer' },
    { kind: 'move', label: 'Move on', hint: 'Skip ahead to this track’s last phrase' },
    { kind: 'harsh', label: 'Too much', hint: 'Too loud or too harsh — ease off' },
  ];

  // The server's buckets, mirrored: Yes and Too much share one, Stay and Move on another.
  const now0 = performance.now();
  const buckets = { reaction: new TokenBucket(RATE_LIMITS.reaction, now0), keep: new TokenBucket(RATE_LIMITS.keep, now0) };
  const bucketOf = (k: Kind) => (k === 'stay' || k === 'move' ? buckets.keep : buckets.reaction);

  let cooling = $state<Record<'reaction' | 'keep', number>>({ reaction: 1, keep: 1 });
  let pressed = $state<Kind | null>(null);
  let ballot = $state<{ v: 1 | -1; sectionId: string } | null>(null);
  let message = $state<string | null>(null);
  let messageTimer: ReturnType<typeof setTimeout> | null = null;

  const cycle = $derived(Number.isFinite($bar) ? $bar : 0);
  const np = $derived(nowPlaying($schedule, cycle));
  const myBallot = $derived(ballot && ballot.sectionId === np.section?.id ? ballot.v : null);
  const pending = $derived($crowd?.keepPending ? keepPendingText($crowd.keepPending, cycle, np.next?.startCycle ?? null) : null);

  function say(text: string, ms = 3500): void {
    message = text;
    if (messageTimer) clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (message = null), ms);
  }

  $effect(() => {
    const n = $nack;
    if (!n || Date.now() - n.at > 3000 || !['react', 'keep'].includes(n.event)) return;
    const text = nackText(n.reason);
    if (text) say(text);
  });

  onMount(() => {
    const id = setInterval(() => {
      const t = performance.now();
      cooling = { reaction: buckets.reaction.progress(t), keep: buckets.keep.progress(t) };
    }, 100);
    return () => {
      clearInterval(id);
      if (messageTimer) clearTimeout(messageTimer);
    };
  });

  export function press(index: number): void {
    const b = BUTTONS[index];
    if (b) act(b.kind);
  }

  function act(kind: Kind): void {
    const bucket = bucketOf(kind);
    const t = performance.now();
    if (!bucket.take(t)) {
      say('Easy — give it a second.', 1800);
      return;
    }
    cooling = { reaction: buckets.reaction.progress(t), keep: buckets.keep.progress(t) };
    let ok: boolean;
    if (kind === 'stay' || kind === 'move') {
      const v = kind === 'stay' ? 1 : -1;
      ok = actions.keep(v);
      if (ok && np.section) ballot = { v, sectionId: np.section.id };
    } else {
      ok = actions.react(kind);
    }
    if (!ok) {
      say('Nothing to react to yet.', 2000);
      return;
    }
    pressed = kind;
    setTimeout(() => pressed === kind && (pressed = null), 200);
    say(CONFIRM[kind], 2600);
  }

  const CONFIRM: Record<Kind, string> = {
    fire: 'Yes — etched into the rim.',
    stay: 'You asked to stay. The room weighs it over the next 8 bars.',
    move: 'You asked to move on. The room weighs it over the next 8 bars.',
    harsh: 'Noted. If enough of the room agrees, the mix eases off.',
  };

  const ringOf = (k: Kind) => (k === 'stay' || k === 'move' ? cooling.keep : cooling.reaction);
</script>

<div class="dock-inner">
  <div class="buttons">
    {#each BUTTONS as b, i (b.kind)}
      {@const ring = ringOf(b.kind)}
      <button
        type="button"
        class="react {b.kind}"
        class:hit={pressed === b.kind}
        class:cooling={ring < 1}
        class:chosen={(b.kind === 'stay' && myBallot === 1) || (b.kind === 'move' && myBallot === -1)}
        aria-keyshortcuts={String(i + 1)}
        aria-pressed={b.kind === 'stay' ? myBallot === 1 : b.kind === 'move' ? myBallot === -1 : undefined}
        aria-disabled={ring < 1}
        aria-label={b.label}
        title="{b.hint} ({i + 1})"
        data-kind={b.kind}
        onclick={() => act(b.kind)}
      >
        <span class="icon" style:--ring={ring}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {#if b.kind === 'fire'}
              <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.3 3.7-8.3.4 1.9 1.3 3 2.4 3.6-.2-3 .9-5.6 3-7.1-.2 3 1.4 4.6 2.7 6.4 1 1.4 1.6 2.9 1.6 4.9C18.9 18.4 16 21 12 21Z" />
            {:else if b.kind === 'stay'}
              <circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.2" class="fill" />
            {:else if b.kind === 'move'}
              <path d="M4 12h15M13.5 6.5 19 12l-5.5 5.5" />
            {:else}
              <path d="M3 14c2-4 4-4 6 0s4 4 6 0 4-4 6 0M3 9c2-4 4-4 6 0s4 4 6 0 4-4 6 0" />
            {/if}
          </svg>
        </span>
        <span class="label">{b.label}</span>
        <kbd aria-hidden="true">{i + 1}</kbd>
      </button>
    {/each}
  </div>
  <p class="line" role="status">
    {#if message}{message}{:else if pending}{pending}{:else if myBallot}{myBallot > 0 ? 'You asked to stay on this track.' : 'You asked to move on.'}{/if}
  </p>
</div>

<style>
  /* Buttons stay centred; the status line lives in the right-hand column so it never shifts them. */
  .dock-inner {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: var(--s-4);
  }
  .buttons {
    grid-column: 2;
    display: flex;
    gap: var(--s-2);
  }
  .react {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 0 16px 0 10px;
    border-radius: var(--r-pill);
    border: 1px solid var(--edge);
    background: var(--lacquer-1);
    font-size: var(--t-sm);
    color: var(--paper);
    transition:
      transform var(--env-hit),
      background-color var(--env-hit),
      border-color var(--env-hit);
  }
  .react:hover {
    background: var(--lacquer-3);
  }
  .react.hit {
    transform: scale(0.95);
    background: var(--lacquer-3);
    border-color: var(--paper);
  }
  .react.chosen {
    border-color: var(--paper);
    box-shadow: inset 0 0 0 1px var(--paper);
  }
  .react.cooling {
    color: var(--paper-2);
  }
  .icon {
    position: relative;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    /* The cooldown ring drains and refills with the rate limit's next token. */
    background: conic-gradient(var(--ring-colour, var(--paper-3)) calc(var(--ring) * 360deg), transparent 0);
    --ring-colour: transparent;
  }
  .cooling .icon {
    --ring-colour: var(--paper-2);
  }
  .icon::after {
    content: '';
    position: absolute;
    inset: 2px;
    border-radius: 50%;
    background: var(--lacquer-1);
  }
  .react:hover .icon::after,
  .react.hit .icon::after {
    background: var(--lacquer-3);
  }
  svg {
    position: relative;
    z-index: 1;
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .fire svg {
    stroke: var(--clay-2);
  }
  .harsh svg {
    stroke: var(--paper-2);
  }
  svg .fill {
    fill: currentColor;
    stroke: none;
  }
  kbd {
    font: inherit;
    font-size: 10px;
    color: var(--paper-3);
    border: 1px solid var(--groove);
    border-radius: 4px;
    padding: 0 4px;
    line-height: 1.4;
  }
  .line {
    grid-column: 3;
    min-width: 0;
    max-width: 300px;
    font-size: var(--t-xs);
    line-height: 1.4;
    color: var(--clay-2);
  }

  :global([data-layout='phone']) .dock-inner {
    display: flex;
    flex-direction: column-reverse;
    align-items: stretch;
    gap: 6px;
  }
  :global([data-layout='phone']) .buttons {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }
  :global([data-layout='phone']) .react {
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    min-height: 52px;
    padding: 4px 4px;
    border-radius: 14px;
    font-size: 11px;
  }
  :global([data-layout='phone']) kbd {
    display: none;
  }
  :global([data-layout='phone']) .icon {
    width: 24px;
    height: 24px;
  }
  /* On a phone the line floats just above the dock instead of taking a row of the thumb zone. */
  :global([data-layout='phone']) .line {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    max-width: none;
    padding: 10px var(--gutter) 6px;
    text-align: center;
    pointer-events: none;
  }
  :global([data-layout='phone']) .line:not(:empty) {
    background: linear-gradient(rgb(7 6 10 / 0), rgb(7 6 10 / 0.94) 40%);
  }
</style>
