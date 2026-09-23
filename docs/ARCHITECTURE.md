# B-Side architecture

B-Side is a live listening room. Claude composes music as [Strudel](https://strudel.cc) code, every
listener's browser performs it in sync, and the room steers where it goes. This document is the
design everything is built against; the typed contracts live in `src/shared/`, `src/server/types.ts`,
`src/client/engine/types.ts` and `src/client/render/protocol.ts`.

- [1. What the proof of concept taught us](#1-what-the-proof-of-concept-taught-us)
- [2. Principles](#2-principles)
- [3. System overview](#3-system-overview)
- [4. Time](#4-time)
- [5. The musical model](#5-the-musical-model)
- [6. From plan to sound](#6-from-plan-to-sound)
- [7. The composer](#7-the-composer)
- [8. The crowd](#8-the-crowd)
- [9. Arc, dramaturgy and novelty](#9-arc-dramaturgy-and-novelty)
- [10. The sound palette](#10-the-sound-palette)
- [11. Safety](#11-safety)
- [12. The client](#12-the-client)
- [13. Module map](#13-module-map)
- [14. Testing](#14-testing)
- [15. Operating it](#15-operating-it)

---

## 1. What the proof of concept taught us

The first version (kept in `legacy/` for reference) proved the idea and taught a lot. The research
behind this redesign measured its failures rather than guessing:

| Problem | What actually happened |
|---|---|
| Tempo | `setcps(bpm/60)` played everything **4× too fast**: Strudel's convention is 1 cycle = 1 bar, so 120 BPM is `cps 0.5`. |
| "Everyone hears the same music" | Each browser started its own clock on click and applied updates on arrival. No two listeners were in sync. |
| Fades | Level fades re-evaluated the entire program every bar, and `.gain(level)` overwrote the model's own gain patterns. |
| Stability | Every update called `repl.start()`, leaking a `requestAnimationFrame` loop each time; after ~1 h the scheduler logged dropouts. |
| One bad voice | A single broken part froze or silenced the whole mix, with no error reported back to Claude. |
| Security | Listener suggestion text steered Claude's code, which ran as arbitrary JavaScript in every browser. One malformed socket message crashed the server. |
| Mood model | Regex "energy" over code, an alarmist "⚠️ OVER BUDGET" prompt, two dislikes from anyone forcing a full regeneration, likes doing nothing, style memory turning "no more techno" into *liked: techno* — and then never reaching Claude, whose prompt said it made "undefined music". |
| Convergence | ~1,200 sounds were loaded; the prompt showed about seven, and every parse failure fell back to `swpad:3`. |

The good ideas survive: levels separate from patterns, "transitions are the music", staggered
entries, sections as the unit of form, and Claude explaining its intent.

## 2. Principles

1. **Three roles with hard boundaries.** The **Conductor** (server, deterministic) owns time, the
   arc, guardrails and the crowd. The **Composer** (Claude, or a stand-in) writes sections. The
   **Performer** (every browser) renders the committed timeline, in sync.
2. **Time is musical and shared.** 1 cycle = 1 bar. The server owns one timeline; clients compute
   "which bar is it" from it. Changes land on bar boundaries, announced ahead.
3. **Code is data until proven safe.** Composer code is parsed against an allowlist, evaluated in
   an isolated worker, analysed, and only then broadcast. Clients re-validate and clamp.
4. **Measure, don't guess.** Descriptors come from the actual events a pattern produces (and
   from client audio telemetry), never from regexes over code. They describe; they never alarm.
5. **Pressure, not commands.** Listeners bend a planned trajectory. Nothing a single listener does
   causes a regeneration; sustained, broad agreement does, with hysteresis.
6. **Silence never happens.** Late composer → the current section keeps playing. Broken part →
   only that part drops. Failing composer → the autopilot takes over.
7. **Novelty is enforced, not hoped for.** A ledger of what played, cooldowns, a fresh crate of
   sounds per movement, and similarity rejection.
8. **Any composer, one contract.** Claude, a script, or a person at a terminal all see the same
   context and use the same two operations: *audition* and *commit*.

## 3. System overview

```
                       ┌──────────────────────────── server (Node) ───────────────────────────────┐
  Claude API ◄───────► │ Composer driver ──┐                                                       │
  bside CLI  ◄─ HTTP ─►│ (claude|external| │ audition/commit    ┌──────────┐                       │
                       │  scripted)        └──────────────────► │Conductor │◄── Ledger / Store      │
                       │                                        │ arc      │                       │
                       │ Checker (worker pool) ◄── code ──────  │ horizon  │── programs ─┐         │
                       │ validate→evaluate→analyze              │ mixer    │             │         │
                       │                                        └──┬───▲───┘             ▼         │
                       │ RoomClock (timeline) ──────── bars ───────┘   │ signals    Broadcaster    │
                       │ Crowd (pad, keep, reactions, requests, forks) ┘            (socket.io)    │
                       └────────────────────────────────────────────────────────────────┬──────────┘
                                                                                        │ welcome, timeline,
                                                                                        │ section, mixer, crowd…
                ┌──────────────────────────────── each browser ───────────────────────────▼─────────┐
                │ Room connection + clock sync ──► Engine (Strudel, SyncedScheduler, mixer, master)  │
                │           ▲  pad/keep/react/request/vote/telemetry        │ hap events, meters     │
                │           └──────────── Svelte UI ◄───────────────────────┤                        │
                │                          (code view, pull pad, liner notes, dock, requests, votes) │
                │                                   Lathe renderer (OffscreenCanvas worker) ◄────────┘
                └───────────────────────────────────────────────────────────────────────────────────┘
```

One process serves everything: the API, the socket, and the client (Vite middleware in
development, the built bundle in production).

## 4. Time

**Convention.** 1 cycle = 1 bar of 4/4; `cps = bpm / 60 / 4` (`src/shared/music.ts`).

**Server clock.** `performance.timeOrigin + performance.now()` in ms: monotonic, unlike `Date.now()`.

**Timeline** (`src/shared/timeline.ts`). Piecewise-constant tempo segments
`{startMs, startCycle, cps}`. `cycleAtMs` / `msAtCycle` are pure functions every client runs. A tempo
change is a new segment starting at a future bar boundary (published ≥ 1 s ahead), so everyone
switches at the same instant with continuous phase. A ramp is a run of one-bar segments.

**Client sync.** NTP-style: the client sends `clock` probes (socket.io ack), keeps the lowest-RTT
third of 8–16 samples, offset = `serverMs − (t0 + t1) / 2`, re-probes every 30–60 s. AudioContext
time maps to wall time through `getOutputTimestamp()` (discarding stale readings, EMA-smoothed,
snapping on jumps > 50 ms), which folds output latency in.

**Scheduler.** Strudel's `Cyclist` cannot follow an external clock, so the engine uses a
`SyncedScheduler` (prototype verified: two pages within ±7.5 ms acoustically). Every 50 ms it
queries `[lastEnd, cycleAt(now + 0.25 s))` and schedules each onset at the audio time of its cycle.
Timers come from `worker-timers` so background tabs aren't throttled.

**Bars on the server.** `RoomClock.onBar` fires at each integer cycle (drift-corrected
`setTimeout`). The conductor uses it for scheduling decisions; clients never wait for it.

## 5. The musical model

```
Session (hours)        ledger of everything played, loved moments
 └ Movement (6–20 min) a "side" of the record: tempo centre, tonal centre, groove family,
   │                   palette, arc shape, baseline intensity/brightness (bent by the crowd)
   └ Section (8–64 bars, usually 16–32)  a "track": role (intro/groove/build/drop/…),
     │                  scale, targets (intensity/brightness/density/tension spans),
     │                  transition in, 1–8 parts, liner note
     └ Part            one Strudel expression + role + fader level + enter/exit bars +
                       knobs + automation lanes + optional duck target
```

The composer writes **Plans** (`src/shared/plan.ts`): 1–2 sections at a time, optionally a new
movement, a fork vote, and decisions on listener requests. The conductor compiles accepted
sections into **SectionPrograms** (`src/shared/program.ts`), which is what listeners receive.

**Section extent.** A section sounds from its `startCycle` until the next committed section
starts. `bars` is its *planned* length; if nothing follows in time, it keeps playing (a vamp). This
single rule makes late composers harmless and needs no server coordination.

**Parts carry.** A part whose `code` is `null` continues the code of the same part id from the
previous section. Parts not listed in a new section leave at its bar 0 (tails ring out).

**Transitions** (`TransitionType`), all rendered deterministically on every client:

| Type | What the performer does |
|---|---|
| `cut` | Previous parts stop at bar 0. |
| `crossfade` (n bars) | Previous section keeps playing n bars into the new one, fading out, while new parts fade in. |
| `riser` (n bars) | An engine-owned noise riser plays over the last n bars before bar 0. |
| `breath` (n bars) | The previous section is muted for its final n bars — a held breath before the downbeat. |

Tempo changes are separate: `bpm` + `tempoRampBars` on the section schedule timeline segments.

## 6. From plan to sound

**On the server**, `Conductor.accept(plan)`:

1. Schema (zod), then cross-field rules: bars vs enter/exit/automation, knob ranges, carried ids
   exist, request ids known, public text free of URLs/markup.
2. Every part's code through the **Checker** (validate → evaluate → analyse, 16 bars at the
   section's tempo, in a worker). Errors are phrased for self-repair (rule, message, line/col,
   excerpt, hint — "Unknown method `.reverb` — did you mean `.room`?").
3. Musical rules: key fit ≥ 0.8 for pitched parts (unless `chromatic`), bass register, kick density,
   hap limits, unknown sounds, soundfont ranges, measured intensity/brightness within ±0.2 of the
   target midpoints (warning), mix peak overlap.
4. Novelty and dramaturgy rules (§9): cooldown introductions, similarity, peak/floor budgets,
   tempo limits.
5. Compile: assign ids, `startCycle`s (after the committed horizon, on bar boundaries), orbits per
   part (stable per id, 1–16), duck targets → orbits, instrument labels, measured descriptors.
6. Schedule tempo segments, broadcast `section` (≥ 8 s + 2 bars before bar 0 so clients preload
   samples — cold samples otherwise drop their first hit), record in the ledger.

**On each client**, the performer turns each `ProgramPart` into a pattern:

```
compile(code)                               // validated again client-side, same validator
  → .seed(startCycle).late(startCycle)      // section-relative time; absolute-time randomness
  → window [enter, exit) + transition fades // hap filter + gain envelope
  → level(cycle) × trims × macros           // multiplies postgain per hap (never overwrites gain)
  → clamp(HAP_LIMITS) + strip engine keys   // src/shared/limits.ts
  → .orbit(part.orbit) (+ duckorbit)        // engine-owned routing
  → guard                                   // a throwing part returns [] and reports; others play
```

All of this is applied in engine JavaScript *around* the evaluated expression, so the code the
listener sees in the code view is exactly the code that was evaluated, and mini-notation
highlight offsets stay correct.

**Levels and knobs never re-evaluate code.** `knob("cut")` inside part code resolves, per part,
to `ref(() => knobValue)`; faders are per-hap multipliers computed at each hap's onset cycle, so
every client produces the same values. The fast-lane macros (§8) move them continuously.

**Master chain.** superdough has no limiter: orbit sum → `DynamicsCompressor` (limiter settings)
→ soft clipper → safety/tilt EQ (low shelf 150 Hz, high shelf 3 kHz) → user volume → destination,
with an analyser tap for visuals and telemetry.

## 7. The composer

### 7.1 One interface, three drivers

```ts
interface Composer { compose(request: PlanRequest, tools: ComposerTools, signal: AbortSignal): Promise<ComposeOutcome> }
interface ComposerTools { audition(input): Promise<AuditionResult>; commit(plan): Promise<CommitResult> }
```

| Driver | Who composes | Use |
|---|---|---|
| `claude` | Claude via the Messages API, tool loop | Production. Default when `ANTHROPIC_API_KEY` is set. |
| `external` | Anyone over HTTP — a person with the `bside` CLI, Claude Code, a script | Development, live-coding alongside the room, testing prompts by hand. No SDK needed. |
| `scripted` | A curated library of verified sections, chosen by the arc and the crowd | Autopilot fallback, CI and end-to-end tests, rooms without an API key. |

The driver can be switched at runtime (`POST /api/composer/driver`). Whatever the driver, the
conductor treats its output identically.

### 7.2 The Claude driver

- **Model**: `claude-opus-5` by default (`BSIDE_MODEL` overrides), adaptive thinking,
  `output_config.effort` `medium` for section calls and `high` for movement calls. Streaming with
  `finalMessage()`. Refusal fallback: `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
- **Tools**: `audition` (try parts, get errors + measured digests) and `commit_plan` (strict tool
  whose input schema is `planToolSchema()`). Claude is asked to audition anything uncertain and to
  finish by committing. A rejected commit returns the issues as an error `tool_result`; Claude
  repairs and recommits. Bounded: ≤ 8 tool calls and the request deadline.
- **Prompt**: a stable system prompt (role and aesthetics, the plan contract, the Strudel reference
  card with only validator-approved idioms, the catalog grouped by family) is prompt-cached with a
  1 h TTL. Each call sends one user message: the `TurnContext` as JSON, with listener requests
  inside a block labelled as untrusted data. Calls are stateless: history is the conductor's digest,
  not a growing conversation.
- **Budget**: single flight, ≤ `BSIDE_MAX_CALLS_PER_HOUR` (default 120), no calls while no listener
  is audible (the autopilot vamps instead).

### 7.3 When the conductor asks for a plan

A planning request starts when committed-but-unplayed music drops below **75 s**, or earlier on a
coalesced event: crowd replan pressure, a closed fork, a request surge, a guardrail event, or a
movement older than 14 minutes (then `kind: 'movement'`). Only one request is ever in flight;
events arriving meanwhile are merged into the next. Deadline: a new section must be committed
≥ 8 s + 2 bars before it would start. On failure or timeout, the scripted driver fills the gap and
the UI says so ("Claude is listening to the band vamp").

### 7.4 The external driver and CLI

`src/cli/bside.ts` (`npm run bside -- <command>`) talks to `/api/composer/*`:

```
bside status                     # driver, pending request, what's playing, horizon
bside context                    # the TurnContext a composer would get now (JSON)
bside reference                  # the composer system prompt / Strudel reference card
bside audition parts.json        # or: bside audition --code 's("bd*4").bank("RolandTR909")' --role kick
bside commit plan.json [--now|--next]
bside driver external|claude|scripted
bside watch                      # stream planning requests and section starts (SSE)
```

With the driver set to `external`, planning requests wait for a commit until their deadline, then
the autopilot fills in. Commits are accepted at any time (`--now` interrupts at the next 4-bar
line), so you can play along with — or instead of — Claude.

## 8. The crowd

Listeners apply **pressure, not commands**, through five channels (`src/server/room/crowd.ts`):

| Channel | Gesture | Effect |
|---|---|---|
| **Pull pad** | Drag a puck: x = dark↔bright, y = calm↔intense; relaxes to centre after 90 s | Fast lane (mixer macros) now; bends the movement baseline at the next plan |
| **Keep / Move on** | Per-section ballot | Extend by a phrase, or shorten to the next 8-bar line |
| **Reactions** | 🔥 yes · 🌊 vibing · 💤 bored · 😣 harsh | Salience per section ("loved moments"), novelty pressure, safety trim |
| **Requests** | Short text | Weighed by Claude with a visible lifecycle |
| **Fork votes** | 2–3 options Claude offers every few minutes | Binding or advisory direction for the next section |

**Weight.** `w = trust × presence`, trust rising from 0.35 to 1 over 2 minutes of audible
listening, presence 1 (visible) / 0.5 (hidden tab, audio on) / 0 (not audible), inputs ignored for
the first 10 s, and the total weight of one network (/24 or /56) capped at 2.0.

**Pad aggregate** with a silent-majority prior (β = 0.25) and freshness `s = exp(−age/120 s)`:
`P = Σ w·s·p / (Σ w·s + β·Σ w·(1−s))`. Influence depends on the *fraction* of the room that agrees:
10 % pushing gives ≈ 0.31, 25 % ≈ 0.57, 50 % ≈ 0.80. Diagnostics: turnout, Kish effective voices,
consensus, and split detection (reported to Claude as a split, not averaged into mush).

**Smoothing.** EMA with τ = clamp(20 + 12·ln(1+N), 20, 60) s plus a slew limit of 0.025/s.

**Two speeds.**
- *Fast lane* (within a phrase, deterministic): brightness → master tilt (±4 dB high shelf) and
  knobs that `follow` brightness; intensity → percussion faders +2 dB, pads −1 dB, knobs that follow
  intensity. Clients ramp over ~4 bars.
- *Slow lane* (Claude, next section): the movement baseline moves toward the room by at most 0.15
  per plan (κ = 0.15 + 0.35·confidence). The crowd moves the tide; Claude still writes the waves.

**Early replan** only on strong, sustained consensus: pressure vs baseline > 0.45 for 16 bars
(hysteresis resets below 0.25), Kish n_eff ≥ min(3, N), ≥ 32 bars since the last one.

**Keep / Move on**: same prior, τ = 10 s; |K| > 0.35 for 8 bars → extend one phrase (max 2) or
shorten to the next 8-bar line (never below 16 bars); then all ballots are consumed.

**Reactions**: token bucket (1 per 3 s, burst 5), at most one counted per type per 4-bar window,
attributed to the bar the listener heard. Per-section rates become z-scores against a 15-minute
baseline: 🔥 z ≥ 2 marks a loved moment; 💤 z ≥ 2 raises novelty pressure; 😣 z ≥ 2 (or ≥ 20 % of
listeners within 8 bars) applies a safety trim (−3 dB master, −3 dB high shelf, 16 bars).

**Requests**: sanitised (control characters and `<>` stripped, ≤ 140 chars), merged on a
normalised key, support = Σ w·exp(−age/6 min), top 5 go to the composer. Lifecycle: received →
considered → now / next-section / next-movement / fork-option / merged / declined → playing →
played / expired (15 min). Raw text is shown only to its author; everyone else sees the composer's
paraphrase. Rate: 1 per minute per listener, 30 per minute per room.

**Forks**: at most one every ~3 minutes; binding if the winner has ≥ 50 % with ≥ 20 % turnout,
advisory at ≥ 40 % / 10 %, otherwise the composer's default.

These parameters were simulated (a troll pinning the pad for 5 minutes moves the room by 0.09;
30 sockets from one subnet by 0.17; a flip-flopping half of the room causes zero replans).

## 9. Arc, dramaturgy and novelty

**Arc.** A movement has a baseline (intensity, brightness) and an amplitude A (0.1 plateau … 0.35
peak-and-release). Section roles have expected offsets (×A): intro −1.2/−0.6, groove 0/0,
build −0.4→+0.8 / −0.2→+0.6, drop +1.2/+0.4, breakdown −1.6/−0.4, bridge −0.6/0,
interlude −1.0/0, outro −1.2→−2.0 / −0.6. The conductor sends these as `expected` targets; the
composer may deviate by ±0.15 (more with a stated reason).

**Dramaturgy rules** (violations are errors returned to the composer):
- Peak budget: intensity ≥ 0.8 for ≤ 3 min per 10 min; no three peak sections in a row.
- Floor budget: intensity ≤ 0.2 for ≤ 4 min per 10 min (unless the movement is an ambient plateau).
- A `build` must end ≥ 0.2 more tense than it starts; the following section starts ≥ 0.2 lower.
- Same role at most twice in a row (`groove` three times); minimum 16 bars except `transition`.
- Tempo: |Δ| ≤ 4 BPM within a movement, ramps ≥ 4 bars per 4 BPM, 60–180 overall; a new
  movement may move ≤ 12 BPM unless via a beatless bridge or half/double-time.

**Novelty** (`src/server/conductor/ledger.ts`):
- The **ledger** records every section: sounds with loudness share, scale, BPM, groove grid,
  chord cycle, measured descriptors, crowd outcome.
- **Cooldown**: a sound with loudness share ≥ 0.25 in 3 of the last 6 sections can't be
  *introduced* for 20 minutes (carrying it is fine; movement signatures and reprises exempt).
- **Crate**: each movement gets 16 sounds drawn stratified by family (4 percussion incl. a drum
  machine unused for an hour, 2 bass, 3 harmonic, 3 melodic, 2 texture, 2 wildcards), biased
  toward the room's brightness baseline and toward never-used sounds. New movements must use ≥ 2.
- **Similarity**: a section whose feature vector is within 0.15 of one in the last 20 minutes is
  rejected unless it declares a `reprise`.
- **Flags** (warnings): same beat for 3 sections, repeated chord cycle within 30 minutes, key
  centre unchanged > 12 minutes.

## 10. The sound palette

`npm run catalog` (`scripts/build-catalog.ts`) vendors every sample map into `palette/maps/`,
rewriting `_base` to **commit-pinned** raw GitHub URLs, and generates `palette/catalog.json`
(`src/shared/catalog.ts`). Server and client read the same file.

| Source | Contents | License |
|---|---|---|
| Synths (superdough) | sine/triangle/square/sawtooth, supersaw, pulse, sbd, noises, zzfx | AGPL (Strudel) |
| Wavetables | uzu-wavetables, AKWF (`bubo:waveforms`) — `wt_*` | Unlicense / CC0 |
| tidal-drum-machines | 71 machines, 683 sounds, used as `s("bd").bank("RolandTR909")` | none stated (hot-linked, as strudel.cc does) |
| Dirt-Samples | 218 banks | none stated (hot-linked) |
| VCSL | 128 orchestral/world instruments | CC0 |
| Salamander piano, mridangam | | CC-BY / CC BY-SA |
| switchangel breaks + pads, clean-breaks, eddyflux crate | breaks, pads, a 53-kick crate | Unlicense / mixed |
| General MIDI soundfonts | 125 instruments (`gm_*`) with playable ranges | MIT code, GeneralUser GS / FluidR3 |

Maps are fetched in parallel but **registered in a fixed order** (the build asserts there are no
name collisions), so `s("bd:3")` means the same file for every listener and for the validator. The
performer **preloads** each section's samples and soundfont presets when it arrives, because cold
samples drop their first hit.

## 11. Safety

Composer code runs in every listener's browser, and listeners can influence the composer. Defence
in depth:

1. **AST allowlist** (`src/strudel/validate.ts`) on the code as written: only calls to Strudel
   functions and methods (derived automatically from Strudel's own exports, minus a cited
   denylist: `worklet`, `bbexpr`, `K`, `as`, hydra, `samples`, `setcps`, raw callbacks, scope
   mutation, visuals, MIDI/OSC…), literals, arithmetic and expression-bodied arrows. No computed
   member access, `constructor`/`__proto__`, templates with `${}`, labels, assignments or loops.
   The prototype rejected 78/78 malicious snippets and accepted 34/34 idiomatic ones.
2. **Isolated evaluation** in worker threads with a wall-clock timeout, a heap cap, no environment
   and a static + runtime event-density bound.
3. **Client re-validation** with the same validator before compiling anything.
4. **Client clamp** of every hap value (`src/shared/limits.ts`), because server analysis samples a
   window.
5. **Content-Security-Policy** in production: `script-src 'self' 'unsafe-eval' data:` (Strudel
   evaluates code; superdough's worklets are data URLs), `connect-src 'self'
   https://raw.githubusercontent.com` (blocks exfiltration from any future allowlist bypass),
   `frame-ancestors 'none'`.
6. **Listener text is data.** Validated with zod, rate-limited, never rendered as HTML, put in
   the prompt only inside an untrusted-data block, and shown publicly only as the composer's
   paraphrase (checked for URLs/markup).
7. **Hardened inputs**: every socket event schema-validated, every handler wrapped, token
   buckets per event, per-network weight caps, room-wide caps.
8. **Admin surface**: `/api/composer/*` requires `BSIDE_ADMIN_TOKEN` (Bearer), or loopback when unset.

## 12. The client

- **Engine** (`src/client/engine/`): boots pinned `@strudel/*` packages directly (no web component,
  no CDN), registers the catalog, runs the SyncedScheduler, performs sections (§6), owns the
  master chain, and exposes events, lookahead queries, active code locations, meters and
  telemetry (`Engine` in `types.ts`).
- **Lathe renderer** (`src/client/render/`): the record, drawn in an OffscreenCanvas worker from
  engine events (see `docs/DESIGN.md`). Tiers: full / lite / calm (reduced motion), auto-downgrading
  on frame-time or scheduler trouble.
- **UI** (`src/client/ui/`, Svelte 5): landing (the record spins silently in sync before the audio
  unlock), liner notes, the live code view with sounding atoms highlighted, the pull pad with the
  room's school of pucks, the reaction dock, requests, fork votes, legend, volume, calm mode. Mobile
  first; fully keyboard-operable.

## 13. Module map

```
src/
  shared/            contracts used everywhere (no DOM, no Node APIs)
    music.ts timeline.ts limits.ts plan.ts program.ts protocol.ts analysis.ts
    composer-api.ts catalog.ts
  strudel/           isomorphic Strudel toolkit (browser + Node worker)
    env.ts           Strudel scope + allowlists derived from exports
    validate.ts      AST allowlist validator (the security boundary)
    compile.ts       validated code → Pattern (scope as parameters, knob binding, locations)
    analyze.ts       hap-level descriptors, key fit, limits, unknown sounds
    catalog.ts       catalog loading helpers, sound resolution
  server/
    main.ts          boot: config, express, CSP, socket.io, vite middleware / static
    config.ts store.ts log.ts
    room/            clock.ts, crowd.ts, listeners.ts (weights, rate limits), socket.ts
    check/           checker.ts (worker pool), worker.ts
    conductor/       conductor.ts, accept.ts (plan rules), arc.ts, ledger.ts, compile.ts, mixer.ts
    composer/        claude.ts, external.ts, scripted.ts, reference.ts (system prompt), context.ts,
                     library/ (verified sections for the scripted driver)
    http/            api.ts (health, state, composer routes, SSE)
  client/
    main.ts index.html
    engine/          boot.ts, scheduler.ts, clock-sync.ts, performer.ts, master.ts, sounds.ts, engine.ts
    render/          protocol.ts, lathe.ts, worker.ts, host.ts
    room/            connection.ts (socket, snapshot → stores)
    ui/              App.svelte + components, stores.ts, tokens.css
  cli/bside.ts       the external composer CLI
palette/             vendored maps + catalog.json (generated)
scripts/             build-catalog.ts, render-audio.ts (offline audio QA)
test/                vitest unit + integration tests
e2e/                 Playwright tests (scripted driver, no API key needed)
legacy/              the proof of concept, for reference
```

## 14. Testing

- **Unit** (vitest): timeline math, limits, plan schema; the validator security suite (malicious
  and idiomatic corpora); analyzer descriptors; crowd aggregation scenarios (troll, sybils, split,
  whiplash, keep/move-on); conductor scheduling with a fake clock, checker and composer; the Claude
  driver against a stubbed Anthropic client (tool loop, repair, refusal, timeout).
- **Integration**: boot the server with the scripted driver, connect socket.io clients, assert
  welcome/section/timeline flow and composer API round trips.
- **End to end** (Playwright, headless Chromium, scripted driver — no API key): landing record
  spins, unlock starts the engine, events fire on the shared grid, the code view highlights,
  the pad and reactions round-trip, reduced motion works, mobile layout fits.
- **Audio QA**: `scripts/render-audio.ts` renders library sections offline in headless Chromium
  and checks peak, RMS and clipping.

## 15. Operating it

| Env | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables the Claude driver |
| `BSIDE_COMPOSER` | `claude` if a key is set, else `scripted` | Initial driver |
| `BSIDE_MODEL` | `claude-opus-5` | |
| `BSIDE_MAX_CALLS_PER_HOUR` | 120 | Hard budget |
| `BSIDE_ADMIN_TOKEN` | — | Guards `/api/composer/*` (loopback-only when unset) |
| `PORT` | 3000 | |
| `BSIDE_DATA_DIR` | `./data` | Ledger and session state (JSON) |
| `BSIDE_SOURCE_URL` | this repository | Shown in the UI (AGPL-3.0 §13) |

Cost is roughly one Claude call per section (30–90 s of music); nothing is spent while the room is
empty. Everything is AGPL-3.0-or-later, as Strudel is; a hosted room must offer its source, which
the UI links to.
