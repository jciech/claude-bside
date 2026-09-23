<script lang="ts">
  // The pull: a shared mood pad. Others are dots in their identity hue, you are the white ring, the
  // room's pull is a soft field, and the music (the needle) is the clay dot trailing toward it.
  // The canvas redraws only on crowd frames (≤ 10 Hz) and on your own drag — never in a loop.
  import { onMount } from 'svelte';
  import type { PadPoint } from '../../../shared/protocol.ts';
  import { useRoom } from '../context.ts';
  import { axisWords, driftText, hueColor, padWords } from '../format.ts';
  import { clampPad, nudgeAxis, PAD_RELAX_MS, padToPixel, pointerToPad, school } from '../pad.ts';

  const { room, calm } = useRoom();
  const { crowd, you } = room.stores;
  const { actions, engine } = room;

  const TRAIL = 28;
  const KEY_RELEASE_MS = 900;

  let canvas = $state<HTMLCanvasElement>();
  let me = $state<PadPoint | null>(null);
  let dragging = $state(false);
  let touchedAt = 0;
  let trail: PadPoint[] = [];
  let raf = 0;
  let keyRelease: ReturnType<typeof setTimeout> | null = null;

  const frame = $derived($crowd);
  const status = $derived.by(() => {
    if (!frame) return 'Waiting for the room…';
    // The room only counts a lean after a few seconds of listening (and a frame or two to arrive).
    if (me && frame.turnout <= 0.001) return 'Your lean joins the room after a few seconds of listening.';
    return driftText(frame.needle, frame.pull, { listeners: frame.listeners, turnout: frame.turnout, cps: engine.cps(), split: frame.split });
  });

  function draw(): void {
    raf = 0;
    const c = canvas;
    if (!c || c.width === 0 || c.height === 0) return;
    const g = c.getContext('2d');
    if (!g) return;
    const dpr = c.width / Math.max(1, c.clientWidth);
    const W = c.width;
    const H = c.height;
    const px = (p: PadPoint) => padToPixel(p, W, H);
    g.clearRect(0, 0, W, H);

    g.lineWidth = dpr;
    g.strokeStyle = 'rgba(239,231,214,0.05)';
    g.beginPath();
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      g.moveTo((i / 8) * W, 0);
      g.lineTo((i / 8) * W, H);
      g.moveTo(0, (i / 8) * H);
      g.lineTo(W, (i / 8) * H);
    }
    g.stroke();
    g.strokeStyle = 'rgba(239,231,214,0.14)';
    g.beginPath();
    g.moveTo(W / 2, 0);
    g.lineTo(W / 2, H);
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();

    const f = $crowd;
    if (f) {
      const t = performance.now() / 1000;
      f.ghosts.forEach((ghost, i) => {
        const p = $calm ? ghost : school(ghost, i, t);
        const [x, y] = px(p);
        g.globalAlpha = 0.78;
        g.fillStyle = hueColor(ghost.hue);
        g.beginPath();
        g.arc(x, y, 3.2 * dpr, 0, Math.PI * 2);
        g.fill();
      });
      g.globalAlpha = 1;

      const [qx, qy] = px(f.pull);
      const field = g.createRadialGradient(qx, qy, 0, qx, qy, Math.max(W, H) * 0.24);
      field.addColorStop(0, `rgba(239,231,214,${0.1 + 0.14 * f.consensus})`);
      field.addColorStop(1, 'rgba(239,231,214,0)');
      g.fillStyle = field;
      g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(239,231,214,0.75)';
      g.setLineDash([3 * dpr, 4 * dpr]);
      g.beginPath();
      g.arc(qx, qy, 11 * dpr, 0, Math.PI * 2);
      g.stroke();

      const [nx, ny] = px(f.needle);
      g.strokeStyle = 'rgba(226,124,92,0.6)';
      g.lineWidth = 1.5 * dpr;
      g.setLineDash([2 * dpr, 5 * dpr]);
      g.beginPath();
      g.moveTo(nx, ny);
      g.lineTo(qx, qy);
      g.stroke();
      g.setLineDash([]);

      if (trail.length > 1) {
        for (let i = 1; i < trail.length; i++) {
          const [ax, ay] = px(trail[i - 1]!);
          const [bx, by] = px(trail[i]!);
          g.strokeStyle = `rgba(226,124,92,${(0.4 * i) / trail.length})`;
          g.beginPath();
          g.moveTo(ax, ay);
          g.lineTo(bx, by);
          g.stroke();
        }
      }
      g.fillStyle = '#e27c5c';
      g.beginPath();
      g.arc(nx, ny, 6 * dpr, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#e27c5c';
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      g.arc(nx, ny, 12 * dpr, 0, Math.PI * 2);
      g.stroke();
    }

    if (me) {
      const age = dragging ? 0 : Date.now() - touchedAt;
      const alpha = Math.max(0.25, 1 - age / PAD_RELAX_MS);
      const [mx, my] = px(me);
      g.globalAlpha = alpha;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.arc(mx, my, (dragging ? 15 : 10) * dpr, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = $you ? hueColor($you.hue) : '#ffffff';
      g.beginPath();
      g.arc(mx, my, 3.5 * dpr, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
  }

  function redraw(): void {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  // Every crowd frame: extend the needle's trail and repaint once.
  $effect(() => {
    const f = $crowd;
    if (!f) return;
    const last = trail[trail.length - 1];
    if (!last || Math.hypot(last.x - f.needle.x, last.y - f.needle.y) > 0.002) trail = [...trail, f.needle].slice(-TRAIL);
    redraw();
  });
  $effect(() => {
    void $calm;
    void me;
    redraw();
  });

  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      if (!entry || !canvas) return;
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.round(entry.contentRect.width * dpr);
      canvas.height = Math.round(entry.contentRect.height * dpr);
      redraw();
    });
    ro.observe(canvas!);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (keyRelease) clearTimeout(keyRelease);
    };
  });

  function place(p: PadPoint, active: boolean): void {
    me = clampPad(p);
    touchedAt = Date.now();
    actions.pad(me, active);
    redraw();
  }

  function pointerdown(e: PointerEvent): void {
    if (e.button !== 0) return;
    canvas!.setPointerCapture(e.pointerId);
    dragging = true;
    place(pointerToPad(e.clientX, e.clientY, canvas!.getBoundingClientRect()), true);
  }
  function pointermove(e: PointerEvent): void {
    if (dragging) place(pointerToPad(e.clientX, e.clientY, canvas!.getBoundingClientRect()), true);
  }
  function pointerup(): void {
    if (!dragging || !me) return;
    dragging = false;
    place(me, false);
  }

  function keyboard(axis: 'x' | 'y', e: KeyboardEvent): void {
    const current = me ?? { x: 0, y: 0 };
    if (e.key === 'Escape') {
      if (me) place(me, false);
      return;
    }
    const next = nudgeAxis(current[axis], e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    place({ ...current, [axis]: next }, true);
    if (keyRelease) clearTimeout(keyRelease);
    keyRelease = setTimeout(() => me && place(me, false), KEY_RELEASE_MS);
  }
</script>

<section class="pull" id="panel-pull" data-panel="pull" aria-labelledby="pull-h">
  <h2 id="pull-h" class="rail-h">The pull <span class="sub">drag to lean the room</span></h2>
  <div class="pad" class:dragging>
    <canvas
      bind:this={canvas}
      aria-hidden="true"
      onpointerdown={pointerdown}
      onpointermove={pointermove}
      onpointerup={pointerup}
      onpointercancel={pointerup}
    ></canvas>
    <span class="ax top">intense</span>
    <span class="ax bottom">calm</span>
    <span class="ax left">dark</span>
    <span class="ax right">bright</span>
    <div class="sliders" role="group" aria-label="Lean the room: brightness and intensity">
      <label>
        <span class="sr-only">Brightness, dark to bright</span>
        <input
          id="pull-x"
          type="range"
          min="-1"
          max="1"
          step="0.05"
          value={me?.x ?? 0}
          aria-valuetext={axisWords('x', me?.x ?? 0)}
          onkeydown={(e) => keyboard('x', e)}
        />
      </label>
      <label>
        <span class="sr-only">Intensity, calm to intense</span>
        <input
          id="pull-y"
          type="range"
          min="-1"
          max="1"
          step="0.05"
          value={me?.y ?? 0}
          aria-valuetext={axisWords('y', me?.y ?? 0)}
          onkeydown={(e) => keyboard('y', e)}
        />
      </label>
    </div>
  </div>
  <p class="status"><span class="dot" aria-hidden="true"></span><span>{status}</span></p>
  <p class="me">
    {#if me}You lean <strong>{padWords(me)}</strong>{dragging ? '' : ' — it fades after a minute and a half'}.{:else}Tap or drag anywhere on the pad to lean.{/if}
  </p>
  <ul class="key" aria-hidden="true">
    <li><i class="k-you"></i>you</li>
    <li><i class="k-room"></i>the room</li>
    <li><i class="k-music"></i>the music</li>
  </ul>
</section>

<style>
  .pull {
    padding: var(--s-5) var(--s-5) var(--s-4);
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
  .pad {
    position: relative;
    aspect-ratio: 1;
    border-radius: var(--r-md);
    background:
      radial-gradient(120% 120% at 100% 0%, rgb(242 164 136 / 0.06), transparent 55%),
      radial-gradient(120% 120% at 0% 100%, rgb(160 139 255 / 0.06), transparent 55%),
      var(--lacquer-1);
    border: 1px solid var(--edge);
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .pad:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: crosshair;
    touch-action: none;
  }
  .dragging canvas {
    cursor: grabbing;
  }
  .ax {
    position: absolute;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-3);
    pointer-events: none;
  }
  .top {
    top: 8px;
    left: 50%;
    translate: -50% 0;
  }
  .bottom {
    bottom: 8px;
    left: 50%;
    translate: -50% 0;
  }
  .left {
    left: 10px;
    top: 50%;
    translate: 0 -50%;
    writing-mode: vertical-rl;
    rotate: 180deg;
  }
  .right {
    right: 10px;
    top: 50%;
    translate: 0 -50%;
    writing-mode: vertical-rl;
  }
  .sliders {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .status {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-top: var(--s-3);
    font-size: var(--t-sm);
    line-height: 1.5;
    color: var(--paper);
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--clay);
    translate: 0 -1px;
  }
  .me {
    margin-top: var(--s-1);
    padding-left: 15px;
    font-size: var(--t-xs);
    color: var(--paper-3);
  }
  .me strong {
    color: var(--paper-2);
    font-weight: 600;
  }
  .key {
    display: flex;
    gap: var(--s-4);
    margin-top: var(--s-3);
    padding-left: 15px;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-3);
  }
  .key li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .key i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .k-you {
    border: 1.5px solid #fff;
  }
  .k-room {
    border: 1.5px dashed var(--paper-2);
  }
  .k-music {
    background: var(--clay);
  }
  :global([data-layout='phone']) .pull {
    padding: var(--s-3) var(--gutter) var(--s-4);
  }
  :global([data-layout='phone']) .pad {
    aspect-ratio: 1.85;
  }
  :global([data-layout='tablet']) .pad {
    aspect-ratio: 1.15;
  }
</style>
