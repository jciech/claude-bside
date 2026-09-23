<script lang="ts">
  // One glyph per voice family, so colour is never the only cue (docs/DESIGN.md voice spectrum).
  import type { VoiceFamily } from '../../../shared/music.ts';

  let { family, size = 10 }: { family: VoiceFamily; size?: number } = $props();
</script>

<svg class="glyph" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
  {#if family === 'kick'}
    <circle cx="5" cy="5" r="4.2" />
  {:else if family === 'bass'}
    <rect x="0.5" y="3" width="9" height="4" rx="2" />
  {:else if family === 'snare'}
    <path d="M5 0.8 9.4 9.2H0.6Z" />
  {:else if family === 'hat'}
    <rect x="3.9" y="0.5" width="2.2" height="9" rx="1" />
  {:else if family === 'lead'}
    <path d="M5 0.4 9.6 5 5 9.6 0.4 5Z" />
  {:else if family === 'keys'}
    <path d="M0.5 1h9v2h-9zM0.5 4h9v2h-9zM0.5 7h9v2h-9z" />
  {:else if family === 'pad'}
    <circle cx="5" cy="5" r="3.6" class="ring" />
  {:else}
    <path d="M5 0.5v9M0.5 5h9M1.8 1.8l6.4 6.4M8.2 1.8 1.8 8.2" class="star" />
  {/if}
</svg>

<style>
  .glyph {
    flex: none;
    display: block;
    fill: currentColor;
  }
  .ring {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
  }
  .star {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }
</style>
