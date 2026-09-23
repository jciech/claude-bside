<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { CATALOG_URL } from '../../../shared/catalog.ts';
  import { scoreBarAt } from '../../../shared/schedule.ts';
  import { parseCatalog } from '../../../strudel/catalog.ts';
  import { useRoom } from '../context.ts';
  import { bpmOf, sideLetter } from '../format.ts';
  import { mapsForSounds, strudelProgram, strudelUrl } from '../export.ts';
  import { audibleInstances, nowPlaying, partState } from '../now.ts';
  import { sectionAtCycle } from '../stores.ts';
  import PartRow from './PartRow.svelte';

  const { room, pulse, partErrors, calm } = useRoom();
  const { engine } = room;
  const { schedule, sourceUrl } = room.stores;
  const bar = pulse.bar;

  /** Short hits stay lit long enough to see. */
  const MIN_LIT_MS = 120;

  let follow = $state(true);
  let copied = $state<'idle' | 'copied' | 'failed'>('idle');
  let section = $state<HTMLElement>();
  let list = $state<HTMLElement>();

  const cycle = $derived(Number.isFinite($bar) ? $bar : 0);
  const np = $derived(nowPlaying($schedule, cycle));
  const rows = $derived(
    audibleInstances($schedule, cycle).map((x) => {
      const played = cycle - x.section.startCycle;
      const score = played < 0 ? played : scoreBarAt(x.section, played);
      const prevSection = sectionAtCycle($schedule.sections, x.section.startCycle - 1e-6);
      const previousCode = prevSection ? (prevSection.parts.find((p) => p.id === x.part.id)?.code ?? null) : undefined;
      return {
        key: x.key,
        part: x.part,
        previousCode: x.leaving ? undefined : previousCode,
        state: x.leaving ? ('leaving' as const) : partState(x.part, score),
        barsToEnter: Math.max(1, Math.ceil(x.part.enterBar - score)),
        barsPlayed: Math.max(0, played),
        error: $partErrors[x.key]?.message ?? null,
      };
    }),
  );

  // ─── Highlighting: toggle classes only on atoms whose state changed ─────────────────────────────

  const spans = new Map<string, Set<HTMLElement>>();
  const lit = new Set<string>();
  const litUntil = new Map<string, number>();

  function setLit(key: string, on: boolean): void {
    if (on) lit.add(key);
    else lit.delete(key);
    for (const el of spans.get(key) ?? []) el.classList.toggle('on', on);
  }

  function register(node: HTMLElement, key: string) {
    const add = (k: string) => {
      let set = spans.get(k);
      if (!set) spans.set(k, (set = new Set()));
      set.add(node);
      if (lit.has(k)) node.classList.add('on');
    };
    const remove = (k: string) => {
      const set = spans.get(k);
      set?.delete(node);
      if (set && set.size === 0) spans.delete(k);
    };
    add(key);
    return {
      update(next: string) {
        remove(key);
        key = next;
        add(key);
      },
      destroy: () => remove(key),
    };
  }

  onMount(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      // Hidden behind another tab on small screens: nothing to light.
      if (!section || section.offsetParent === null) return;
      const now = performance.now();
      const active = new Set<string>();
      for (const [instance, ranges] of engine.activeLocations()) for (const r of ranges) active.add(`${instance}|${r.start}:${r.end}`);
      for (const key of active) {
        litUntil.set(key, now + MIN_LIT_MS);
        if (!lit.has(key)) setLit(key, true);
      }
      for (const key of [...lit]) {
        if (!active.has(key) && (litUntil.get(key) ?? 0) <= now) {
          setLit(key, false);
          litUntil.delete(key);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });

  // ─── Follow: bring the part that just changed into view ─────────────────────────────────────────

  // Only a rail that scrolls on its own is followed; a phone's page is never scrolled from under you.
  let lastSectionId: string | null | undefined;
  $effect(() => {
    const id = np.section?.id ?? null;
    if (id === lastSectionId) return;
    const first = lastSectionId === undefined;
    lastSectionId = id;
    if (first || !follow) return;
    void tick().then(() => {
      const row = list?.querySelector('.ink')?.closest('article');
      const rail = row?.closest<HTMLElement>('.rail');
      if (!row || !rail || getComputedStyle(rail).overflowY !== 'auto') return;
      const top = row.getBoundingClientRect().top - rail.getBoundingClientRect().top + rail.scrollTop - 24;
      rail.scrollTo({ top, behavior: $calm ? 'auto' : 'smooth' });
    });
  });

  function stopFollowing(): void {
    follow = false;
  }

  // ─── Copy / open in strudel.cc ──────────────────────────────────────────────────────────────────

  async function program(): Promise<string | null> {
    const s = np.section;
    if (!s) return null;
    let maps: ReturnType<typeof mapsForSounds> = [];
    try {
      const catalog = parseCatalog(await (await fetch(CATALOG_URL)).json());
      const sounds = new Set(engine.query(s.startCycle, s.startCycle + Math.min(8, s.bars)).filter((e) => e.sectionId === s.id).map((e) => e.sound));
      maps = mapsForSounds(catalog, sounds);
    } catch {
      // Without the catalog the export still plays built-in sounds.
    }
    return strudelProgram({
      title: s.name,
      side: sideLetter(np.movement?.side ?? 1),
      track: s.track,
      bpm: bpmOf(engine.cps()),
      parts: s.parts.map((p) => ({ id: p.id, code: p.code, level: p.level, knobs: p.knobs })),
      maps,
      sourceUrl: $sourceUrl,
    });
  }

  async function copy(): Promise<void> {
    const text = await program();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = 'copied';
    } catch {
      copied = 'failed';
    }
    setTimeout(() => (copied = 'idle'), 2000);
  }

  function open(): void {
    // Open the tab inside the click (Safari blocks popups opened after an await), then point it at strudel.cc.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    void program().then((text) => {
      if (tab && text) tab.location.href = strudelUrl(text);
      else tab?.close();
    });
  }
</script>

<section class="code-view" data-panel="code" bind:this={section} aria-labelledby="code-h">
  <div class="head">
    <h2 id="code-h" class="rail-h">The code <span class="sub">lit as it sounds</span></h2>
    <div class="actions">
      <button type="button" class="act" aria-pressed={follow} onclick={() => (follow = !follow)} title="Scroll to the part that just changed">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v9M4 7l4 4 4-4M3 14h10" /></svg>follow
      </button>
      <button type="button" class="act" onclick={copy} disabled={!np.section}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" /></svg>{copied === 'copied' ? 'copied' : copied === 'failed' ? 'blocked' : 'copy'}
      </button>
      <button type="button" class="act" onclick={open} disabled={!np.section} title="Open this track in strudel.cc (new tab)">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" /></svg>strudel.cc
      </button>
    </div>
  </div>
  <span class="sr-only" aria-live="polite">{copied === 'copied' ? 'Code copied' : ''}</span>

  {#if rows.length}
    <div class="rows" bind:this={list} role="region" aria-label="Strudel code currently playing" onwheel={stopFollowing} ontouchmove={stopFollowing}>
      {#each rows as r (r.key)}
        <PartRow instance={r.key} part={r.part} previousCode={r.previousCode} state={r.state} barsToEnter={r.barsToEnter} barsPlayed={r.barsPlayed} error={r.error} {register} />
      {/each}
    </div>
  {:else}
    <p class="empty">No code is sounding right now.</p>
  {/if}
</section>

<style>
  .code-view {
    padding: var(--s-4) var(--s-5) var(--s-6);
    border-top: 1px solid var(--groove);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    flex-wrap: wrap;
    margin-bottom: var(--s-3);
  }
  .rail-h {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
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
  .actions {
    display: flex;
    gap: 2px;
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 32px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--t-xs);
    color: var(--paper-2);
  }
  .act:hover:not(:disabled) {
    background: var(--lacquer-3);
    color: var(--paper);
  }
  .act[aria-pressed='true'] {
    color: var(--clay-2);
  }
  .act:disabled {
    opacity: 0.4;
  }
  .act svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .empty {
    font-size: var(--t-sm);
    color: var(--paper-3);
  }
  :global([data-layout='phone']) .code-view {
    padding: var(--s-3) var(--gutter) var(--s-6);
  }
</style>
