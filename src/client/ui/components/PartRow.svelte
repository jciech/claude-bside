<script lang="ts">
  import { ROLE_FAMILY } from '../../../shared/music.ts';
  import type { ProgramPart } from '../../../shared/program.ts';
  import { useRoom } from '../context.ts';
  import { freshInk } from '../ink.ts';
  import type { PartState } from '../now.ts';
  import { atomLocations, segmentPart } from '../segments.ts';
  import VoiceGlyph from './VoiceGlyph.svelte';

  type Register = (node: HTMLElement, key: string) => { update(key: string): void; destroy(): void };

  let {
    instance,
    part,
    previousCode,
    state,
    barsToEnter,
    barsPlayed,
    error,
    register,
  }: {
    instance: string;
    part: ProgramPart;
    /** Code of the same part in the previous track: undefined = no previous track to compare with; null = a new part. */
    previousCode: string | null | undefined;
    state: PartState;
    barsToEnter: number;
    /** Bars since this instance's track started (read once: ink that was already drying keeps drying). */
    barsPlayed: number;
    error: string | null;
    register: Register;
  } = $props();

  const { pulse, mutes } = useRoom();
  const meter = pulse.meter;
  const family = $derived(ROLE_FAMILY[part.role]);
  // Fixed when the row appears: re-reading it every bar would jump the drying animation ahead.
  // svelte-ignore state_referenced_locally
  const inkAge = Math.max(0, barsPlayed);
  const fresh = $derived(previousCode === undefined || inkAge >= 4 ? [] : freshInk(previousCode, part.code));
  const segments = $derived(segmentPart(part.id, part.code, atomLocations(part.code), fresh));
  const muted = $derived($mutes.has(part.id));
</script>

<article
  class="row"
  class:waiting={state === 'waiting'}
  class:leaving={state === 'leaving' || state === 'gone'}
  class:errored={!!error}
  style:--vc="var(--v-{family})"
  style:--ink-delay="calc(var(--bar) * {-inkAge.toFixed(3)})"
  aria-labelledby="row-{instance}"
>
  <div class="gutter">
    <h3 id="row-{instance}" class="name"><VoiceGlyph {family} size={9} /><span>{part.id}</span></h3>
    <span class="meter" use:meter={instance} aria-hidden="true"><i></i></span>
    <span class="instrument" title={part.instrument}>{part.instrument}</span>
  </div>
  <div class="body">
    <pre class="code"><code>{#each segments as seg, i (i)}{#if seg.atom}<span class="atom {seg.cls}" class:ctl={!seg.primary} use:register={`${instance}|${seg.atom}`}>{#if seg.fresh}<span class="ink">{seg.text}</span>{:else}{seg.text}{/if}</span>{:else}<span class={seg.cls} class:ink={seg.fresh}>{seg.text}</span>{/if}{/each}</code></pre>
    {#if error}
      <p class="status err"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 11 10H1Z M6 4.5v2.5 M6 8.6v.1" /></svg>muted: {error}</p>
    {:else if state === 'waiting'}
      <p class="status">enters in {barsToEnter} bar{barsToEnter === 1 ? '' : 's'}</p>
    {:else if state === 'leaving' || state === 'gone'}
      <p class="status">leaving</p>
    {:else if muted}
      <p class="status">muted in your mix</p>
    {/if}
  </div>
</article>

<style>
  .row {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: var(--s-2);
    padding: var(--s-2) 0;
    border-top: 1px solid rgb(51 45 62 / 0.6);
    transition: opacity var(--env-swell);
  }
  .row:first-child {
    border-top: 0;
  }
  .gutter {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-top: 3px;
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vc);
  }
  .name span {
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meter {
    display: block;
    width: 48px;
    height: 3px;
    border-radius: 2px;
    background: var(--lacquer-3);
    overflow: hidden;
  }
  .meter i {
    display: block;
    height: 100%;
    background: var(--vc);
    transform-origin: left;
    transform: scaleX(var(--m, 0));
    transition: transform 70ms linear;
  }
  .instrument {
    font-size: 10px;
    color: var(--paper-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    min-width: 0;
  }
  .code {
    font: inherit;
    font-size: var(--t-code);
    line-height: 1.7;
    color: var(--paper-2);
    white-space: pre;
    overflow-x: auto;
    scrollbar-width: none;
    tab-size: 2;
  }
  .code::-webkit-scrollbar {
    display: none;
  }
  .label {
    color: var(--vc);
    font-weight: 650;
  }
  .fn {
    color: var(--paper);
  }
  .str {
    color: #dccba5;
  }
  .num {
    color: #eab680;
  }
  .punct {
    color: var(--paper-3);
  }
  .atom {
    border-radius: 3px;
    transition:
      background-color 90ms linear,
      color 90ms linear,
      box-shadow 90ms linear;
  }
  .atom:global(.on) {
    color: var(--lit-ink);
    background: var(--vc);
    box-shadow:
      0 0 0 1px var(--vc),
      0 0 12px 0 color-mix(in srgb, var(--vc) 70%, transparent);
  }
  .atom.ctl:global(.on) {
    color: inherit;
    background: none;
    box-shadow: inset 0 -2px 0 var(--vc);
  }
  /* Ink sits on its own span, so a lit atom and drying ink never fight over one background. */
  .ink {
    border-radius: 2px;
    animation: dry calc(var(--bar) * 4) linear var(--ink-delay) both;
  }
  @keyframes dry {
    from {
      background-color: rgb(226 124 92 / 0.2);
      box-shadow: inset 0 -1px 0 var(--clay);
    }
    to {
      background-color: rgb(226 124 92 / 0);
      box-shadow: inset 0 -1px 0 rgb(226 124 92 / 0);
    }
  }
  /* Fresh ink is colour, not motion: it keeps drying over 4 bars in calm mode too. */
  :global([data-calm='true']) .row .ink {
    animation-duration: calc(var(--bar) * 4) !important;
  }
  @media (prefers-reduced-motion: reduce) {
    .row .ink {
      animation-duration: calc(var(--bar) * 4) !important;
    }
  }
  .status {
    margin-top: 2px;
    font-size: var(--t-xs);
    color: var(--paper-3);
  }
  .status.err {
    display: flex;
    gap: 6px;
    align-items: baseline;
    color: var(--clay-2);
  }
  .status svg {
    width: 11px;
    height: 11px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .waiting .code,
  .leaving .code {
    opacity: 0.5;
  }
  .leaving .name span {
    text-decoration: line-through;
  }
  .errored .code {
    text-decoration: line-through;
    text-decoration-color: rgb(242 164 136 / 0.5);
  }
</style>
