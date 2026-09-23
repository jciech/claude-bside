<script lang="ts">
  import { useRoom } from '../context.ts';
  import { nackText, plural } from '../format.ts';

  const { room, pulse } = useRoom();
  const { fork, nack } = room.stores;
  const bar = pulse.bar;

  let picked = $state<{ forkId: string; option: 'A' | 'B' | 'C' } | null>(null);
  let problem = $state<string | null>(null);

  const f = $derived($fork);
  const cycle = $derived(Number.isFinite($bar) ? $bar : 0);
  const mine = $derived(f ? (picked?.forkId === f.id ? picked.option : f.myVote) : null);
  const closed = $derived(!!f && (f.result !== null || cycle >= f.closesAtCycle));
  const left = $derived(f ? Math.max(0, Math.ceil(f.closesAtCycle - cycle)) : 0);
  const leader = $derived(f ? Object.entries(f.tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null : null);

  const outcome = $derived.by(() => {
    if (!f || !closed) return '';
    if (!f.result) return 'Too few votes this time — Claude decides.';
    const o = f.options.find((x) => x.id === f.result!.option);
    const lands = f.landsAtCycle !== null ? ` It lands at bar ${f.landsAtCycle}.` : '';
    return f.result.binding ? `The room decided: ${o?.label ?? f.result.option}.${lands}` : `The room leans ${o?.label ?? f.result.option} — Claude takes it as advice.${lands}`;
  });

  $effect(() => {
    const n = $nack;
    if (n?.event === 'vote' && Date.now() - n.at < 5000) problem = nackText(n.reason);
  });

  function vote(option: 'A' | 'B' | 'C'): void {
    if (!f || closed) return;
    picked = { forkId: f.id, option };
    problem = null;
    room.actions.vote(f.id, option);
  }
</script>

<section class="vote" id="panel-vote" data-panel="vote" aria-labelledby="vote-h">
  <h2 id="vote-h" class="rail-h">
    Next move
    {#if f}
      <span class="sub num">{closed ? 'closed' : `closes at bar ${f.closesAtCycle} · in ${plural(left, 'bar')}`}</span>
    {/if}
  </h2>
  {#if f}
    <fieldset class="options" disabled={closed}>
      <legend id="vote-legend" tabindex="-1">{f.prompt}</legend>
      {#each f.options as o (o.id)}
        {@const share = f.tally[o.id] ?? 0}
        <label class="option" class:mine={mine === o.id} class:winner={closed && f.result?.option === o.id} class:faded={closed && f.result !== null && f.result.option !== o.id}>
          <input type="radio" name="fork-{f.id}" value={o.id} checked={mine === o.id} onchange={() => vote(o.id)} />
          <span class="body">
            <span class="fill" style:transform="scaleX({share})" aria-hidden="true"></span>
            <span class="k" aria-hidden="true">{o.id}</span>
            <span class="t">
              <strong>{o.label}</strong>
              <span class="d">{o.description}</span>
            </span>
            <span class="n num" aria-label="{Math.round(share * 100)} percent">{Math.round(share * 100)}%</span>
          </span>
        </label>
      {/each}
    </fieldset>
    <p class="foot">
      {#if closed}
        <span class="result">{outcome}</span>
      {:else}
        {Math.round(f.turnout * 100)}% of the room has voted{#if leader && (f.tally[leader] ?? 0) > 0} · {leader} leads{/if}{#if mine} · you picked {mine}{/if}
      {/if}
    </p>
    {#if problem}<p class="problem" role="status">{problem}</p>{/if}
  {:else}
    <p class="empty">No vote open. Every few minutes Claude offers the room a fork in the road — it shows up here.</p>
  {/if}
  <p class="sr-only" aria-live="polite">{outcome}</p>
</section>

<style>
  .vote {
    padding: var(--s-4) var(--s-5);
    border-top: 1px solid var(--groove);
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
  .options {
    border: 0;
    display: grid;
    gap: var(--s-2);
    min-width: 0;
  }
  legend {
    margin-bottom: var(--s-2);
    font-family: var(--f-voice);
    font-style: italic;
    font-size: var(--t-base);
    color: var(--paper);
  }
  legend:focus {
    outline: none;
  }
  .option {
    position: relative;
    display: block;
    cursor: pointer;
  }
  .option input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }
  .body {
    position: relative;
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    gap: var(--s-2);
    align-items: center;
    min-height: 52px;
    padding: 8px 12px;
    border-radius: var(--r-sm);
    background: var(--lacquer-1);
    border: 1px solid var(--edge);
    overflow: hidden;
    transition:
      border-color var(--env-hit),
      opacity var(--env-swell);
  }
  .option:hover .body {
    border-color: var(--paper-2);
  }
  .option input:focus-visible + .body {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }
  .option.mine .body {
    border-color: var(--paper);
    box-shadow: inset 0 0 0 1px var(--paper);
  }
  .fill {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgb(239 231 214 / 0.1), rgb(239 231 214 / 0.05));
    transform-origin: left;
    transition: transform var(--env-pluck);
  }
  .winner .fill {
    background: linear-gradient(90deg, rgb(226 124 92 / 0.28), rgb(226 124 92 / 0.12));
  }
  .winner .body {
    border-color: var(--clay);
  }
  .faded .body {
    opacity: 0.55;
  }
  .k {
    position: relative;
    font-family: var(--f-display);
    font-weight: 800;
    font-size: 1.05rem;
    color: var(--paper-2);
  }
  .mine .k,
  .winner .k {
    color: var(--paper);
  }
  .t {
    position: relative;
    display: grid;
    gap: 1px;
    font-size: var(--t-sm);
    min-width: 0;
  }
  .t strong {
    font-weight: 600;
    color: var(--paper);
  }
  .d {
    font-size: var(--t-xs);
    color: var(--paper-2);
  }
  .n {
    position: relative;
    font-size: var(--t-xs);
    color: var(--paper-2);
  }
  .foot {
    margin-top: var(--s-2);
    font-size: var(--t-xs);
    color: var(--paper-3);
  }
  .result {
    color: var(--clay-2);
    font-size: var(--t-sm);
  }
  .problem {
    margin-top: var(--s-1);
    font-size: var(--t-xs);
    color: var(--clay-2);
  }
  .empty {
    font-size: var(--t-sm);
    color: var(--paper-3);
  }
  fieldset:disabled .option {
    cursor: default;
  }
  :global([data-layout='phone']) .vote {
    padding: var(--s-3) var(--gutter) var(--s-4);
    border-top: 0;
  }
</style>
