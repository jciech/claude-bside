<script lang="ts">
  import { onMount } from 'svelte';
  import { cubicInOut } from 'svelte/easing';
  import { plannedPlayBars } from '../../../shared/schedule.ts';
  import type { EtchType } from '../../../shared/music.ts';
  import { createLathe } from '../../render/host.ts';
  import type { LatheHost, SideSection } from '../../render/protocol.ts';
  import { useRoom } from '../context.ts';
  import { composerByline, sideLetter } from '../format.ts';
  import { mediaQuery, onPixelRatioChange } from '../media.ts';
  import { nowPlaying } from '../now.ts';

  let { entered }: { entered: boolean } = $props();
  const { room, calm, settings, pulse } = useRoom();
  const { engine, clock, stores } = room;
  const { schedule, crowd, composer, etches: myEtches } = stores;
  const bar = pulse.bar;
  const contrastMore = mediaQuery('(prefers-contrast: more)');

  let box = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  let host = $state.raw<LatheHost | null>(null);
  let drawn = $state(false);
  let size = $state({ w: 0, h: 0 });
  let label = $state({ inverted: false, listening: false });

  const np = $derived(nowPlaying($schedule, Number.isFinite($bar) ? $bar : 0));
  const side = $derived(np.movement ? sideLetter(np.movement.side) : 'A');
  const byline = $derived(composerByline($composer?.driver ?? 'claude'));
  // The label is 0.30 R and R = 0.93 · min(w, h) / 2 (docs/DESIGN.md "The Lathe").
  const labelSize = $derived(Math.round(0.279 * Math.min(size.w, size.h)));
  // Titles are the composer's (≤ 40 chars): shrink long ones so they fit inside the label's rings.
  const titleSize = $derived.by(() => {
    const name = np.section?.name ?? '';
    const longest = Math.max(4, ...name.split(/\s+/).map((w) => w.length));
    return Math.min(10.5, 58 / (0.62 * longest), name.length > 16 ? 8.6 : 10.5, name.length > 26 ? 7 : 10.5);
  });

  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      size = { w: width, h: height };
      host?.resize(width, height, devicePixelRatio || 1);
    });
    ro.observe(box!);
    const offRatio = onPixelRatioChange((dpr) => host?.resize(size.w, size.h, dpr));
    let cancelled = false;
    let offs: (() => void)[] = [];
    // Draw only once the clock is synced: before that the engine's "now" is not the room's bar.
    void clock.ready.then(() => {
      if (cancelled || !canvas || !box) return;
      const rect = box.getBoundingClientRect();
      try {
        const h = createLathe(canvas, engine, { tier: $calm ? 'calm' : 'full', useWorker: true, prefs: { contrastMore: $contrastMore } });
        h.resize(rect.width, rect.height, devicePixelRatio || 1);
        offs = [
          h.on('label', (s) => (label = s)),
          h.on('stats', () => (drawn = true)),
        ];
        host = h;
        // Stats arrive once a second; don't keep the placeholder that long.
        setTimeout(() => (drawn = true), 600);
      } catch (e) {
        console.warn('[record] the lathe could not start', e);
      }
    });
    return () => {
      cancelled = true;
      ro.disconnect();
      offRatio();
      for (const off of offs) off();
      host?.destroy();
    };
  });

  $effect(() => host?.setTier($calm ? 'calm' : 'full'));
  $effect(() => host?.setPrefs({ contrastMore: $contrastMore }));
  $effect(() => host?.pause($settings.pauseVisuals));

  // The side as the lathe lays it out: this movement's played tracks plus its committed ones.
  $effect(() => {
    if (!host) return;
    const m = np.movement;
    const byId = new Map<string, SideSection>();
    for (const t of m?.tracks ?? []) byId.set(t.id, { ...t, provisional: false });
    for (const s of $schedule.sections) {
      if (m && s.movementId !== m.id) continue;
      byId.set(s.id, { id: s.id, name: s.name, role: s.role, startCycle: s.startCycle, bars: plannedPlayBars(s), provisional: s.provisional });
    }
    host.setSide(m, [...byId.values()].sort((a, b) => a.startCycle - b.startCycle));
  });

  $effect(() => {
    const frame = $crowd;
    if (!host || !frame) return;
    host.setCrowd(frame.pull, frame.needle);
  });

  // Everyone's reactions from the room, plus the listener's own right away (the rim dedupes).
  $effect(() => {
    if (!host) return;
    const all: { type: EtchType; cycle: number; hue: number }[] = [...($crowd?.etches ?? []), ...$myEtches];
    host.etch(all);
  });

  /** Vertical wipe of the title on the downbeat of a new track (a quick fade when calm). */
  function wipe(_node: Element, { calm: still }: { calm: boolean }) {
    const bar = 1000 / Math.max(0.1, engine.cps());
    if (still) return { duration: 200, css: (t: number) => `opacity: ${t}` };
    return { duration: bar * 0.5, easing: cubicInOut, css: (t: number) => `clip-path: inset(0 0 ${(1 - t) * 100}% 0)` };
  }
</script>

<div class="record" class:entered bind:this={box}>
  <div class="placeholder" class:gone={drawn} aria-hidden="true"></div>
  <canvas bind:this={canvas} class:live={host !== null} aria-hidden="true"></canvas>
  {#if labelSize > 40}
    <div class="label" class:inverted={label.inverted} style:--label="{labelSize}px" aria-hidden="true">
      <div class="label-inner">
        {#if label.listening || !np.section}
          <span class="label-side">Side {side}</span>
          <span class="label-title listening">— listening —</span>
        {:else}
          <span class="label-side">Side {side}</span>
          {#key np.section.id}
            <span class="label-title" style:--title-size="{titleSize.toFixed(2)}cqw" in:wipe={{ calm: $calm }}>{np.section.name}</span>
          {/key}
          <span class="label-by">{byline}</span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .record {
    position: relative;
    container-type: size;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    view-transition-name: record;
  }
  .record:not(.entered) {
    aspect-ratio: 1;
    flex: none;
    width: min(100%, 86dvh);
    margin-inline: auto;
  }
  :global([data-layout='phone']) .record:not(.entered) {
    flex: none;
    width: 100%;
    height: min(100vw - 16px, 50dvh);
    aspect-ratio: auto;
  }
  /* In the room the panel below needs the space: the record gives up a little. */
  :global([data-layout='phone']) .record.entered {
    flex: none;
    width: 100%;
    height: min(100vw - 32px, 40dvh);
  }

  canvas,
  .placeholder {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  canvas {
    opacity: 0;
    transition: opacity 600ms ease;
  }
  canvas.live {
    opacity: 1;
  }

  /* A still record until the lathe draws its first frames (same geometry: R = 0.93 · min / 2). */
  .placeholder {
    margin: auto;
    width: calc(93 * min(1cqw, 1cqh));
    height: calc(93 * min(1cqw, 1cqh));
    border-radius: 50%;
    background:
      radial-gradient(circle, var(--label-paper) 0 13.9%, transparent 14.1%),
      repeating-radial-gradient(circle, #121016 0 2px, #1a1720 2px 4px),
      var(--lacquer-1);
    box-shadow: 0 0 0 1px var(--groove);
    transition: opacity 600ms ease;
  }
  .placeholder.gone {
    opacity: 0;
  }

  .label {
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--label);
    height: var(--label);
    translate: -50% -50%;
    border-radius: 50%;
    display: grid;
    place-items: center;
    pointer-events: none;
    container-type: inline-size;
    color: var(--label-ink);
  }
  .label-inner {
    width: 64%;
    display: grid;
    justify-items: center;
    gap: 3cqw;
    text-align: center;
  }
  .label-side {
    font-family: var(--f-mono);
    font-size: max(7px, 5.6cqw);
    font-weight: 600;
    letter-spacing: 0.26em;
    text-transform: uppercase;
    color: var(--label-side);
    white-space: nowrap;
  }
  .label-title {
    font-family: var(--f-display);
    font-weight: 800;
    font-stretch: calc(60% + var(--energy) * 50%);
    font-size: max(8px, var(--title-size, 10.5cqw));
    line-height: 0.95;
    text-transform: uppercase;
    text-wrap: balance;
    overflow-wrap: anywhere;
    max-height: 2.9em;
    overflow: hidden;
    transition: font-stretch var(--env-swell);
  }
  .label-title.listening {
    font-family: var(--f-voice);
    font-style: italic;
    font-weight: 400;
    text-transform: none;
    font-size: max(9px, 8cqw);
    color: var(--label-by);
  }
  .label-by {
    font-family: var(--f-voice);
    font-style: italic;
    font-size: max(8px, 6.8cqw);
    color: var(--label-by);
    white-space: nowrap;
  }
  .label.inverted,
  .label.inverted .label-side,
  .label.inverted .label-by {
    color: var(--clay-ink);
  }
  .label {
    transition: color 150ms linear;
  }

  @media (forced-colors: active) {
    .placeholder {
      display: none;
    }
    .label {
      color: CanvasText;
    }
  }
</style>
