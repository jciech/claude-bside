<script lang="ts">
  // The mark: a five-groove disc whose clay spindle hole sits off centre — the B-side quirk.
  let { size = 24, spin = false }: { size?: number; spin?: boolean } = $props();
  const uid = $props.id();
</script>

<svg class="mark" class:spin width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="{uid}-lacquer" cx="38%" cy="30%" r="80%">
      <stop offset="0" stop-color="#2a2433" />
      <stop offset=".55" stop-color="#110f16" />
      <stop offset="1" stop-color="#07060a" />
    </radialGradient>
  </defs>
  <circle cx="50" cy="50" r="48" fill="url(#{uid}-lacquer)" />
  <g fill="none" stroke="#5a5066" stroke-width="2.4">
    <circle cx="50" cy="50" r="42.5" />
    <circle cx="50" cy="50" r="36.5" />
    <circle cx="50" cy="50" r="30.5" />
    <circle cx="50" cy="50" r="24.5" />
  </g>
  <circle cx="50" cy="50" r="47" fill="none" stroke="#756c80" stroke-width="2" />
  <circle cx="50" cy="50" r="17" fill="#ece2cc" />
  <circle cx="54" cy="48" r="4.2" fill="#e27c5c" />
</svg>

<style>
  .mark {
    display: block;
    flex: none;
  }
  .spin {
    animation: turn 2s linear infinite;
  }
  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }
</style>
