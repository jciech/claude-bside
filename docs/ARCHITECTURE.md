# B-Side architecture

B-Side is a live listening room. Claude composes music as [Strudel](https://strudel.cc) code, every
listener's browser performs it in sync, and the room steers where it goes. This document is the
design everything is built against. The typed contracts are normative and live in `src/shared/`
(music, timeline, schedule, limits, text, plan, program, protocol, analysis, composer-api, catalog),
`src/server/types.ts`, `src/client/engine/types.ts` and `src/client/render/protocol.ts`.

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
- [13. Persistence and restarts](#13-persistence-and-restarts)
- [14. Module map](#14-module-map)
- [15. Testing](#15-testing)
- [16. Operating it](#16-operating-it)

---

## 1. What the proof of concept taught us

The first version (kept in `legacy/` for reference) proved the idea. The research behind this
redesign measured its failures rather than guessing:

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
   arc, guardrails and scheduling. The **Composer** (Claude, or a stand-in) writes sections. The
   **Performer** (every browser) renders the committed schedule, in sync.
2. **Time is musical and shared.** 1 cycle = 1 bar. The server owns one timeline; clients compute
   "which bar is it" from it. Nothing already broadcast changes after its **lock point**.
3. **Code is data until proven safe.** Composer code is parsed against a static allowlist, evaluated
   in an isolated worker, analysed over its whole length, and only then broadcast. Clients
   re-validate with the same allowlist and sanitize every hap.
4. **Measure, don't guess.** Descriptors come from the events a pattern actually produces (and from
   client audio telemetry), never from regexes over code. They describe; they never alarm.
5. **Pressure, not commands.** Listeners bend a planned trajectory. The fast lane answers within a
   bar or two; structure answers at the next unlocked section. Nothing one listener does causes a
   regeneration.
6. **Silence never happens.** Late composer → the tail section loops its last phrase. Broken part →
   only that part drops. Failing composer → the autopilot continues the current material.
7. **Novelty across movements, coherence within them.** A ledger, cooldowns at movement boundaries,
   a fresh crate of sounds per movement, similarity checks against earlier movements — and free
   recurrence, motifs and reprises inside a movement.
8. **Any composer, one contract.** Claude, a script, or a person at a terminal all see the same
   context and use the same two operations: *audition* and *commit*.

## 3. System overview

```
                       ┌──────────────────────────── server (Node) ───────────────────────────────┐
  Claude API ◄───────► │ Composer driver ──┐                                                       │
  bside CLI  ◄─ HTTP ─►│ (claude|external| │ audition/commit    ┌──────────┐                       │
                       │  scripted)        └──────────────────► │Conductor │◄── Ledger / Store      │
                       │                                        │ arc      │                       │
                       │ Checker (worker pool) ◄── code ──────  │ planning │── schedule ─┐         │
                       │ validate→evaluate→analyze              │ mixer    │             │         │
                       │                                        └──┬───▲───┘             ▼         │
                       │ RoomClock (timeline) ──────── bars ───────┘   │ tick()     Broadcaster    │
                       │ Crowd (identity, pad, keep, reactions, requests, forks)    (socket.io)    │
                       └────────────────────────────────────────────────────────────────┬──────────┘
                                                                                        │ welcome, schedule,
                                                                                        │ mixer, crowd, notes…
                ┌──────────────────────────────── each browser ───────────────────────────▼─────────┐
                │ Room connection + ClockSync ──► Engine (Strudel, SyncedScheduler, channels, master)│
                │           ▲  pad/keep/react/request/vote/telemetry        │ hap events, meters     │
                │           └──────────── Svelte UI ◄───────────────────────┤                        │
                │                          (code view, pull pad, liner notes, dock, requests, votes) │
                │                                   Lathe renderer (OffscreenCanvas worker) ◄────────┘
                └───────────────────────────────────────────────────────────────────────────────────┘
```

One process serves everything: the API, the socket, and the client (Vite middleware in development,
the built bundle in production). Event ownership: the conductor emits `schedule`, `mixer`, `note`
and `composer`; the crowd emits `crowd` (4 Hz) and per-listener `fork`, `requests` and `nack`; the
socket layer emits `welcome`.

## 4. Time

**Convention.** 1 cycle = 1 bar of 4/4; `cps = bpm / 60 / 4` (`src/shared/music.ts`). Odd feels are
written inside the bar (polymeter, `{…}%n`), not by changing the bar.

**Server clock.** `performance.timeOrigin + performance.now()` in ms: monotonic within a process and
close to wall time across processes. Every `*Ms` field in the protocol is server clock.

**Timeline** (`src/shared/timeline.ts`). Piecewise-constant tempo segments `{startMs, startCycle,
cps}`; `cycleAtMs` / `msAtCycle` are pure functions every client runs. The future tempo map is
**derived, never mutated**: `buildTimeline(past, lockCycle, sections)` keeps what is locked and
rebuilds the rest from each committed section's tempo instruction (a switch, a ramp at the start, or
a ramp into the end), so moving or revoking a section can never corrupt later tempo changes.

**Lock point** (`src/shared/schedule.ts`). A section *influences* sound from `startCycle −
preRollBars` (riser/breath/filter transitions and pickup parts act before bar 0). Once the server
clock passes `lockMs = msAtCycle(influence) − max(4 s, 2 bars)`, the section's existence,
startCycle, transition and parts — and its predecessor's extent — are immutable. A section must reach
clients by `msAtCycle(influence) − (8 s + 2 bars)` so they can preload it. Placement happens on
4-bar lines. These rules are why the performer never has to un-play something superdough has
already been handed.

**Client sync.** `ClockSync` (websocket transport only) sends `clock` probes, keeps the best third of
8–16 samples (RTT ≤ 500 ms), and is `ready` after ≥ 5 good samples — no audio before that.
Corrections ≤ 50 ms are slewed at ≤ 5 ms/s; larger ones are explicit steps the scheduler handles
(skip forward; hold without re-querying backward). It re-bursts on reconnect, `visibilitychange`,
`pageshow`, `online`, and when a sleep/step is detected (`Date.now() − performance.now()` jumps).
AudioContext time maps to wall time through `getOutputTimestamp()` (stale readings discarded,
EMA-smoothed, snapping on jumps > 50 ms), which folds output latency in.

**Scheduler.** Strudel's `Cyclist` cannot follow an external clock, so the engine uses a
`SyncedScheduler` (prototype verified: two pages within ±7.5 ms acoustically). Every 50 ms it
queries `[lastEnd, cycleAt(now + 0.25 s))`, split at tempo-segment boundaries so `_cps` is right,
and schedules each onset at the audio time of its cycle. Timers come from `worker-timers` so
background tabs aren't throttled.

**Bars on the server.** `RoomClock.onBar` fires at each integer cycle (drift-corrected
`setTimeout`). The conductor uses it for decisions; clients never wait for it.

## 5. The musical model

```
Session (hours)        ledger of everything played, loved moments
 └ Movement (6–20 min) a "side" of the record: tempo centre, tonal centre, groove family, palette,
   │                   arc shape, form sketch, motifs, baseline intensity/brightness (crowd-bent)
   └ Section (8–64 bars, usually 16–32)  a "track": role (intro/groove/build/drop/…), scale
     │                  (may alternate per bar), targets (spans), transition in, 1–8 parts, liner note
     └ Part            one Strudel expression + role + fader level + enter/exit bars (negative =
                       pickup) + knobs + automation lanes + optional multi-target duck
```

The composer writes **Plans** (`src/shared/plan.ts`): 1–2 sections at a time, optionally a new
movement (with `startsAtSection` 0 or 1, so one call can close the old side and open the new one), a
fork vote, motifs to remember, and decisions on listener requests tied to the section that honours
them. The conductor compiles accepted sections into **SectionPrograms** (`src/shared/program.ts`).

**Play time and score time.** A section is composed as `bars` bars of *score*. It sounds from
`startCycle` until the next section starts. Stay and Move on insert **jumps** into its score (Stay
repeats the penultimate phrase so the ending — fills, riser tops, automation tails — still ends the
section; Move on skips ahead to the final phrase). If nothing follows in time, the section **vamps**:
its last phrase (`vamp.loopBars`) loops, windows and automation hold, pattern time continues. Roles
whose vamp would be wrong (build, transition, intro, outro, or anything whose held state is silent)
set `vamp.allowed = false`, and the conductor guarantees a successor before their lock point.

**Part instances.** Each (section, part) pair is an instance with its own orbit and engine channel.
A part whose `code` is `null` is **carried**: same code, same knobs. Unless `restart` is set it
**continues** — one uninterrupted instance across the boundary, its phrase carrying on (the
conductor sets `originCycle` so pattern time picks up exactly where it was). Parts not listed in a
new section leave at its bar 0 with a short release.

**Transitions** (`TransitionType`), rendered deterministically on every client and never applied to
continuing parts:

| Type | What the performer does |
|---|---|
| `cut` | Previous parts end at bar 0 (release: 1 beat percussive, 1 bar otherwise). |
| `crossfade` (≤ 8 bars) | Previous parts keep playing, looping their last phrase, and fade out while new parts fade in. If the scales differ, outgoing pitched parts cut instead. A rewritten same-id part crossfades against itself on a different orbit. |
| `riser` (pre-roll) | An engine-native noise riser sweeps 200 → 8000 Hz over the last n bars before bar 0. |
| `breath` (pre-roll, ≤ 2 bars) | The previous section falls silent for its final n bars. |
| `filter` (pre-roll) | Outgoing parts are low-passed shut over the last n bars; incoming parts' high-pass opens over n/2. |

Tempo is part of the section: `bpm` + `tempoRampBars` + `tempoRampAt` ('start' or 'end'), within
±4 BPM of the movement centre.

## 6. From plan to sound

**On the server**, `Conductor.commit(body, author)` runs serialised through one queue:

1. **Schema** (zod) and cross-field rules: bars vs enter/exit/automation; knob ranges; lanes on the
   same target don't overlap; carried ids exist (a carried part's `knobs: []` inherits); request ids
   known; `tempoRampBars ≤ bars`; crossfade ≤ min(8, half of either section); breath ≤ 2; every public
   string passes `isPublicText` (`src/shared/text.ts`).
2. **Code** through `Checker.checkSection` (validate → evaluate → analyse the full `bars` + one vamp
   loop, at the section's tempo, in a worker): errors are phrased for self-repair — rule, message,
   line/col, excerpt, hint ("Unknown method `.reverb` — did you mean `.room`?").
3. **Musical rules**: key fit per bar against the (possibly alternating) scale — < 0.6 is an error,
   0.6–0.8 a warning, `chromatic` parts exempt; bass register; onsets per bar ≤ `MAX_PART_ONSETS_PER_BAR`;
   hap limits; room/delay parameters constant per part; unknown sounds, soundfont ranges and variants
   that don't exist (`failingVariants`); measured spans within ±0.2 of targets (warning).
4. **Novelty and dramaturgy** (§9) — relaxed for the scripted driver (warnings only).
5. **Placement and compile** under the lock: `startCycle` on the next 4-bar line after the locked
   horizon whose lock point is still ahead; `originCycle`/`continues` for carried parts; orbits
   (continuing parts keep theirs; otherwise the lowest of 1–24 unused by the previous and current
   section); duck targets → orbits; instrument labels; measured spans; trims toward role loudness
   targets from the catalog's measured levels.
6. **Schedule**: rebuild the timeline, bump `rev`, persist the session, broadcast one atomic
   `schedule` update (movements, upserts, revokes). Replaced provisional sections are revoked in
   the same update, never before the replacement is accepted.

**On each client**, the performer renders every instance as specified in
`src/client/engine/types.ts`:

```
compile(code)                                   // same static allowlist; scope = allowlist + m + knob
  → sanitizeModelValue (innermost)              // src/shared/limits.ts: strip engine keys, clamp
  → .seed(originCycle).late(originCycle)        // absolute-time randomness, continuous carried parts
  → score-time mapping (jumps, vamp)            // non-continuing parts only
  → window [enterBar, exitBar)                  // re-onset at entry, truncate + release at exit
  → engine keys: orbit, duck, namespaced cut
  → guard                                       // throws, density and time budget → part muted
channel(instance) = filter → gain               // level × automation × transitions × macros × trims,
                                                // as AudioParam ramps at the audio time of each cycle
```

The code the listener sees is exactly the code that was evaluated, so mini-notation highlight
offsets stay correct. **Nothing re-evaluates to change a level.** Knobs are bound as
`signal(t => knobAt(part, name, scoreBar(t)))`: lane value (or the default, or for carried parts the
value at the previous section's end) plus the follow offset, clamped — identical on every client.

**Master chain.** superdough has no limiter: orbit sum → safety/tilt EQ (low shelf 150 Hz, high
shelf 3 kHz) → master trim → `DynamicsCompressor` (limiter settings) → soft clipper → user volume →
destination, with an analyser tapped after the clipper.

## 7. The composer

### 7.1 One interface, three drivers

```ts
interface Composer { compose(request: PlanRequest, tools: ComposerTools, signal: AbortSignal): Promise<ComposeOutcome> }
interface ComposerTools { request: PlanRequest; audition(input): Promise<AuditionResult>; commit(plan): Promise<CommitResult> }
```

| Driver | Who composes | Use |
|---|---|---|
| `claude` | Claude via the Messages API, tool loop | Production. Default when `ANTHROPIC_API_KEY` is set. |
| `external` | Anyone over HTTP — a person with the `bside` CLI, Claude Code, a script | Development, playing alongside the room, testing prompts by hand. No SDK needed. |
| `scripted` | A boot-validated library plus carry-vamp arrangement moves | Autopilot fallback, CI and end-to-end tests, rooms without an API key. |

Tools are bound to one request: after its signal aborts or after one accepted commit, `commit`
returns `request-closed`. An HTTP commit carrying the pending request's id fulfils it (the external
driver just awaits that). `setDriver` aborts whatever is in flight.

### 7.2 The Claude driver

- **Model**: `claude-opus-5` by default (`BSIDE_MODEL` overrides), adaptive thinking,
  `output_config.effort` `medium` for section calls and `high` for movement calls. Streaming with
  `finalMessage()`. Refusal fallback `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
- **Tools**: `audition` (try parts with their knobs, get errors + measured digests) and
  `commit_plan` (strict tool, input schema `planToolSchema()`). Claude auditions anything uncertain
  and finishes by committing; a rejected commit returns the issues as an error `tool_result` and
  Claude repairs. Bounded by `maxApiCallsPerPlan` (8) and the hard deadline.
- **Prompt**: a stable system prompt — role and aesthetics, the plan contract, the Strudel reference
  card (only validator-approved idioms; `knob("name")` with a declared knob; `.seed(n)` for a random
  motif meant to repeat), the catalog grouped by category and family — is prompt-cached with a 1 h
  TTL. Each call sends one user message: the `TurnContext` as JSON, with listener requests inside a
  block labelled as untrusted data. Calls are stateless; continuity comes from `memory` (last
  rationale, movement intent, form sketch, motifs) and the history digest.
- **Budget**: single flight; at most `BSIDE_MAX_PLANS_PER_HOUR` (default 90) compose calls; no
  Claude calls while no listener is audible (the scripted driver keeps the room alive for free).
  After 3 consecutive failures the autopilot runs for 5 minutes, then one half-open retry.

### 7.3 When the conductor asks for a plan

**Horizon.** Locked music = the playing section plus the next one. A plan's second section is
**provisional**: broadcast at once (clients preload) but replaceable by a crowd replan until its
lock point. A planning request starts when locked, unplayed music drops below
`max(120 s, p90 compose time + 8 s + 2 bars + 20 s)`, or earlier on a coalesced event: crowd
pressure, move-on with no successor, a closed fork, a request surge, a guardrail, or a movement ≥ 12
minutes old (kind `movement`; skipped while the room is clearly loving it, hard cap 20 minutes). A
plan adds between max(16 bars, 60 s) and max(48 bars, 100 s).

**Deadlines.** `softDeadlineMs` = the target's lock point − preload − 3 s of accept budget;
`hardDeadlineMs` = soft + 2 phrases. At the soft deadline, if the tail may vamp, Claude keeps going
until the hard deadline; otherwise the scripted driver commits a pre-validated section immediately.
A plan written against an older `scheduleRev` is re-validated against the current schedule and only
fails (`stale-context`) if a rule actually breaks.

**Boot.** The conductor commits a scripted section synchronously before accepting listeners, whatever
the configured driver.

### 7.4 The scripted autopilot

After a handoff, its first plans are a **carry-vamp**: every current part carried, with deterministic
arrangement moves (drop one part and bring it back every 8 bars, knob and level automation, a
breakdown every third section). Its library sections are key- and tempo-agnostic (scale degrees with
a `$SCALE` placeholder filled with the movement's scale; bpm ranges), tagged by groove and role, and
validated once at boot (results cached by code hash). Scripted commits obey safety, tempo and lead
rules; novelty and dramaturgy violations are warnings, and its ledger rows don't count toward
cooldown or similarity. It may open its own side when the current movement doesn't fit its library.

### 7.5 The external driver and CLI

`src/cli/bside.ts` (`npm run bside -- <command>`) talks to `/api/composer/*`
(routes in `src/shared/composer-api.ts`):

```
bside status                     # driver, pending request, what's playing, horizon
bside context                    # the TurnContext a composer would get now (JSON)
bside reference                  # the composer system prompt / Strudel reference card
bside audition parts.json        # or: bside audition --code 's("bd*4").bank("RolandTR909")' --role kick
bside commit plan.json [--now|--next] [--request <id>]
bside driver external|claude|scripted
bside plan                       # ask the conductor to plan now
bside watch                      # stream planning requests and section starts (SSE)
```

With the driver set to `external`, planning requests wait for a commit until their hard deadline,
then the autopilot fills in. Commits are accepted at any time (`--next` replaces unlocked sections;
`--now` places a cut at the first line whose lock is still ahead), so you can play along with — or
instead of — Claude.

## 8. The crowd

Listeners apply **pressure, not commands** (`src/server/room/crowd.ts`):

| Channel | Gesture | Effect |
|---|---|---|
| **Pull pad** | Drag a puck: x = dark↔bright, y = calm↔intense; relaxes to centre after 90 s | Fast lane (mixer macros) within 1–2 bars; bends the movement baseline at the next plan |
| **Stay / Move on** | Dock buttons, a ballot per section | Stay repeats a phrase; Move on skips to the final phrase. Also recorded as 🌊 vibe / 💤 bored |
| **Yes / Too much** | Dock buttons | 🔥 salience ("loved moments"); 😣 safety trim |
| **Requests** | Short text | Weighed by Claude with a visible lifecycle |
| **Fork votes** | 2–3 options Claude offers every few minutes | Binding or advisory direction |

**Identity and weight.** An anonymous id plus a server-signed token (HMAC, issued in `welcome`);
without a valid token a listener starts fresh. `w = trust × presence`: trust rises 0.35 → 1 over 2
minutes of audible listening; presence 1 (visible) / 0.5 (hidden tab, audio on) / 0 (not audible);
inputs ignored for the first 10 s; heartbeats every 10 s, stale after 25 s. The total weight of one
network (/24 for IPv4, /48 for IPv6, derived from the socket peer or `trustProxy` hops) is capped at
2.0. Sockets per network and connection rates are capped too.

**Pad aggregate** with a silent-majority prior (β = 0.25) and freshness `s = exp(−age/120 s)`:
`P = Σ w·s·p / (Σ w·s + β·Σ w·(1−s))` — influence follows the *fraction* of the room that agrees
(10 % ≈ 0.31, 25 % ≈ 0.57, 50 % ≈ 0.80). Diagnostics: turnout, Kish effective voices, consensus,
split detection (reported to Claude as a split, not averaged into mush).

**Smoothing.** EMA with τ = clamp(2 + 6·ln(1+N), 6, 60) s (N present listeners: 6.2 s solo, 16 s
for 10, 24 s for 40, 43 s for 1000) and a slew of max(0.025, 0.12/√N) per second: a solo listener's
push from the centre reaches ≈ 0.8 of the way in 10 s, gliding at ≤ 0.12/s (a full sweep across the
pad is slew-bound: ≈ 0.6 at 10 s, 0.8 at 15 s); a large room moves deliberately. Weights and network
caps, not slowness, are what resist trolls.

**Two speeds.**
- *Fast lane* (deterministic mixer keyframes, ≤ 1 per bar, ramping over 1 bar for ≤ 3 listeners,
  else 2): brightness → master tilt (±4 dB high shelf) and per-hap cutoff ×2^(mb) / high-pass ×2^(mb/2)
  / sends ×(1 − 0.3·mb); intensity → percussion ±3 dB, pads ∓2 dB; knobs that `follow` an axis move
  by up to half their range. The **needle** (where the music is heading) = the current section's
  target at this bar + its measured offset + the fast lane, so it moves as soon as the room does.
- *Slow lane* (Claude, next unlocked section): the movement baseline moves toward the room by at most
  0.15 per plan (κ = 0.15 + 0.35·confidence), clamped to [0.25, 0.7] unless the movement is ambient.

**Early replan** on strong, sustained consensus: pressure vs baseline > 0.45 for 24 bars (hysteresis
resets below 0.25), Kish n_eff ≥ min(3, N), ≥ 32 bars since the last one. Half a room of 10–200
holding one direction from rest gets there after ≈ 65–80 s (120 BPM); the fast
lane has long since answered, so structure only moves on a lean the room keeps. It replaces the provisional
section, never the locked ones.

**Stay / Move on**: one ballot per listener (the latest wins); ballots carry the section they were
heard in (refused otherwise), are cleared at every section start and consumed once the conductor
acts on them. A ballot fades with freshness exp(−age/90 s) and stops counting below 0.05 (after ≈ 4.5
min); ballots are aggregated with the same silent-majority prior and smoothed with τ = 10 s. |K| >
0.35 held for 8 bars, with a quorum of Kish n_eff ≥ min(2, N) among the ballots (a solo listener can
act alone), acts if the change can still be made before the relevant lock point; the signal repeats
every bar while the lean holds. Stay: one repeated phrase (at most 2 per section; never for intro,
build or transition). Move on: jump to the final phrase at the next 8-bar line (a build may be
shortened); with no successor committed, it requests a plan with reason `move-on`. `keepPending` in
the crowd frame tells the dock what is happening ("moving on at bar 72", "this track ends in 6 bars
anyway", "already held twice"); `blocked` is `min-length`, `next-not-ready`, `role`, `locked` (too
close to a lock point) or `max` (already extended twice).

**Reactions**: token buckets (`RATE_LIMITS` in `music.ts`), at most one counted per type per 4-bar
window, attributed to the bar the listener heard (validated to lie within the last 8 bars). Rates
per section (weighted reactions per listener per minute) become z-scores against a 15-minute
baseline; within a section's rate one listener counts for at most one reaction per type per minute
(max(1, minutes) in all), so a single enthusiast can't manufacture a loved moment or a trim. A
z-signal also needs ≥ min(2, N) distinct reporters. 🔥 z ≥ 2 marks a loved moment; 💤 z ≥ 2 raises
novelty pressure (once per section); 😣 z ≥ 2 (or ≥ 20 % of listeners within 8 bars) applies a safety
trim (−3 dB master, −3 dB high shelf, 16 bars). A repeat trim needs new evidence: at least one Too
much pressed since the last trim, and 16 bars since it (the z test still counts the section's
earlier presses; the 20 % test counts only new ones).

**Requests**: sanitised (`sanitizeRequestText`), merged on a normalised key, support = Σ
w·exp(−age/6 min); the top 5 undecided go into every turn context, plus every open promise
(next-movement / fork-option) whatever its support. Lifecycle: received → considered → planned /
next-movement / fork-option / merged / declined → playing → played / expired (15 min). A request
becomes *considered* only when a real composer (Claude or the external driver) is handed it in a
planning request (`Crowd.markShown`); the autopilot, its fallbacks and `bside context` previews read
the same summary without marking it. Raw text is shown only to its author; everyone sees the
composer's paraphrase. Requests no composer was handed within 5 minutes get a system note. Rate: 1
per minute per listener, 30 per minute per room.

**Forks**: at most one every ~3 minutes (`rules.forkAllowed`); binding if the winner has ≥ 50 % with
≥ 20 % turnout, advisory at ≥ 40 % / 10 %, otherwise the composer's default. The fork shows which
section will realise it and when it lands.

These parameters are simulated in `test/room/crowd-sim.test.ts` (a troll pinning the pad for 5
minutes in a room of 40 moves it by 0.09; 30 sockets from one subnet by 0.17; half the room flipping
every 60 s causes zero replans, while half the room holding one way for a minute is consensus and
replans once).

## 9. Arc, dramaturgy and novelty

**Arc.** A movement has a baseline (intensity, brightness) and an arc shape over its progress p:
plateau (A 0.1, flat), wave (A 0.2, b ± 0.1·sin 4πp), ramp-up (A 0.25, b − 0.15 → b + 0.15),
ramp-down (mirrored), peak-and-release (A 0.35, peak at p ≈ 0.7), terraced (A 0.2, steps every
25 %). Section roles have expected offsets (×A): intro −1.2/−0.6, groove 0/0, build −0.4→+0.8 /
−0.2→+0.6, drop +1.2/+0.4, breakdown −1.6/−0.4, bridge −0.6/0, interlude −1.0/0, outro −1.2→−2.0 /
−0.6. The conductor sends `expected` targets that already satisfy the budgets; they are advisory —
the composer chooses roles freely, and jazz or ambient forms are as valid as EDM arcs.

**Dramaturgy rules** (errors for Claude/external, warnings for the autopilot; the context reports
the current budget state so nobody violates them blindly):
- Peak: target intensity ≥ max(0.8, baseline + 0.25) for ≤ 3 min per 10 min; no three peaks in a row.
- Floor: ≤ 0.2 for ≤ 4 min per 10 min, unless the movement is ambient (baseline ≤ 0.3 or groove free).
- A `build` must *measure* ≥ 0.2 more tense/intense at its end than its start (measured spans), and
  the following section starts lower.
- Same role at most twice in a row (`groove` three times); minimum 16 bars except `transition`.
- Tempo: section bpm within ±4 of its movement; ramps ≥ 4 bars per 4 BPM; a new movement moves ≤ 12
  BPM unless through a beatless bridge (a section with no percussive parts) or half/double time.

**Novelty** (`src/server/conductor/ledger.ts`), with one shared `SectionFingerprint` and
`fingerprintDistance` (`src/shared/analysis.ts`):
- **Similarity** is checked against sections of *previous* movements within 20 minutes (distance
  < 0.15 is an error unless the section declares a `reprise`; reprises across movements ≤ 1 per 30
  min). Inside a movement, recurrence is free; only a `stasis` warning fires when a section is
  within 0.05 of the one before it for the third time running.
- **Cooldown** is checked at movement boundaries: a sound is *introduced* when it hasn't sounded in
  the current movement; sounds with loudness share ≥ 0.25 in 3 of the last 6 (non-scripted,
  audible) sections can't be introduced into a new movement for 20 minutes, except its ≤ 3
  signatures.
- **Crate**: each movement gets 16 sounds drawn stratified by category (4 percussion incl. a drum
  machine unused for an hour, 2 bass, 3 harmonic, 3 melodic, 2 texture, 2 wildcards), biased toward
  the room's brightness and toward never-used sounds; new movements must use ≥ 2.
- **Flags** (warnings): same beat for 3 sections, repeated chord cycle within 30 minutes, key centre
  unchanged > 12 minutes.

## 10. The sound palette

`npm run catalog` (`scripts/build-catalog.ts`) vendors every sample map into `palette/maps/`,
rewriting `_base` to **commit-pinned** raw GitHub URLs, measures each sound's level and brightness
with the offline renderer where possible, and generates `palette/catalog.json`
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
name collisions; the bank-alias map is applied after the drum machines), so `s("bd:3")` means the
same file for every listener and for the validator. Soundfont presets are JavaScript that the loader
evaluates, so `soundfontBase` is a commit-pinned (immutable) raw GitHub URL. The performer
**preloads** each section's samples and soundfont presets when it arrives (cold samples otherwise
drop their first hit), including before the audio unlock, into a suspended AudioContext.

## 11. Safety

Composer code runs in every listener's browser, and listeners can influence the composer. Defence in
depth:

1. **Static allowlist** (`src/strudel/allowlist.generated.json`, generated in Node from core + mini +
   tonal, plus `knob` and `m`, minus a cited denylist) used verbatim by the server validator and the
   client compiler; browser-only packages that extend `Pattern.prototype` never widen it. Denied, for
   stated reasons: `worklet`, `bbexpr`, `K`, `as`, hydra, `samples`, `setcps`/`setcpm`, raw
   per-hap callbacks (`withValue`, `fmap`, `withHap`, `filter`, `bind`, `onTrigger`…),
   `source`/`src`, `FX`, `lfo`/`env`/`bmod`, `channels`, `nudge`, `orbit`/`duck*`, `backgroundImage`
   and the rest of `ui.mjs`, `whenKey`, `timeline`, `calculateSteps`, voicing registries, scope and
   RNG mutators, visuals, MIDI/OSC. `ENGINE_OWNED_KEYS` ⊆ denied keys (a test asserts it). No
   computed member access, `constructor`/`__proto__`, `${}` templates, labels, assignments or loops;
   arrows only with expression bodies that pass the same allowlist; `knob()` only with a string
   literal naming a declared knob. Density arguments (`fast`, `ply`, `*n`, `segment`, `chop`…) must be
   constants ≤ 16.
2. **Isolated evaluation** in worker threads (vm context with no ambient globals), per-job timeout,
   heap cap, recycled workers, and analysis over the whole section plus a vamp loop.
3. **Client re-validation** with the same allowlist before compiling anything, and a compile scope
   that contains exactly the allowlisted values plus `m` and the part's `knob`.
4. **Client sanitization** of every hap value, innermost (`sanitizeModelValue`), and a per-part
   density/time guard plus a per-tick hap cap in the scheduler.
5. **Content-Security-Policy** in production: `default-src 'none'; script-src 'self' 'unsafe-eval'
   blob: data:; worker-src 'self' blob: data:; connect-src 'self' https://raw.githubusercontent.com;
   img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self';
   frame-ancestors 'none'; base-uri 'none'; object-src 'none'` (Strudel evaluates code; superdough's
   worklets are data URLs; worker-timers uses blob workers).
6. **Text is data.** Listener requests and every composer-authored public string go through
   `src/shared/text.ts`; the UI never uses `{@html}` or `innerHTML` (a test greps for it). Requests
   reach the prompt only inside an untrusted-data block; telemetry reaches it only as corroborated
   error *codes*, never free text.
7. **Hardened inputs**: every socket event schema-validated, every handler wrapped, token buckets per
   event, `heardCycle` bounds, per-network weight caps, connection caps, websocket-only transport.
8. **Admin surface**: `/api/composer/*` requires `BSIDE_ADMIN_TOKEN` (timing-safe compare, rate
   limited). In development without a token, only direct loopback peers (raw socket address) are
   allowed; in production without a token the routes are disabled.
9. **Persistence** lives outside every served directory, and persisted programs are re-validated on
   boot before they can be broadcast.

## 12. The client

- **Engine** (`src/client/engine/`): boots pinned `@strudel/*` packages directly (no web component,
  no CDN), registers the catalog, preloads, runs the SyncedScheduler, renders instances (§6), owns
  the master chain, and exposes events, lookahead queries, active code locations (keyed by instance),
  meters, a personal mix (local mutes) and telemetry (`Engine` in `types.ts`). On `unlock` it starts
  at the next bar whose sounds are ready, fading in over a bar, and starts sustained notes already in
  progress with their remaining length.
- **Lathe renderer** (`src/client/render/`): the record, drawn in an OffscreenCanvas worker from
  engine events (see `docs/DESIGN.md`), clocked by epoch-time samples; tiers full / lite / calm
  (reduced motion), auto-downgrading on frame-time or scheduler trouble.
- **UI** (`src/client/ui/`, Svelte 5): landing (the record spins silently in sync before the unlock),
  liner notes, the live code view with sounding atoms highlighted, the pull pad with the room's
  school of pucks, the reaction dock, requests, fork votes, legend, volume, calm mode. Mobile first;
  fully keyboard-operable.

## 13. Persistence and restarts

- **Epoch.** Each boot either warm-restores the previous epoch or starts a new one. Section ids are
  `${epoch}-${seq}` and never collide.
- **Session** (`session.v1`, `PersistedSession` in `src/server/types.ts`): written atomically on
  every schedule change — epoch, rev, counters, timeline, movements (with baseline, crate, form,
  motifs, last rationale), sections, mixer, recent notes.
- **Ledger** (`ledger.v1`): append-only JSONL, one row per section at its bar 0 (revoked sections
  never enter it), in memory for the last 2 hours.
- **Boot.** If the persisted committed horizon still covers the downtime plus the preload lead, the
  same epoch is restored with every `startMs` rebased by the difference between the old and new
  server-clock bases. Otherwise a new epoch starts at `ceil(lastCycle) + 8` (cycles never go
  backwards) with a scripted boot section. Clients see the epoch in `welcome`/`schedule` and, on a
  change, replace everything (`applySnapshot`), fading old material out over a bar.
- `store.flush()` runs on SIGTERM and SIGINT. `BSIDE_DATA_DIR` must be outside every served root.

## 14. Module map

```
src/
  shared/            contracts used everywhere (no DOM, no Node APIs)
    music.ts timeline.ts schedule.ts limits.ts text.ts plan.ts program.ts protocol.ts analysis.ts
    composer-api.ts catalog.ts
  strudel/           isomorphic Strudel toolkit (browser + Node worker)
    allowlist.generated.json  (+ scripts/gen-allowlist.ts), allowlist.ts
    validate.ts      AST allowlist validator (the security boundary)
    compile.ts       validated code → Pattern (scope as parameters, knob binding, locations)
    analyze.ts       hap-level descriptors, key fit, limits, density, fingerprint
    features.ts density.ts scales.ts query.ts mini.ts suggest.ts ("did you mean")
    catalog.ts       parseCatalog, createSoundIndex (pure)
  server/
    main.ts config.ts log.ts types.ts
    node-hooks.ts    Strudel resolve hook for Node (+ registerStrudelHooks for workers)
    room/            clock.ts, crowd.ts (+ aggregate, buckets, requests, telemetry, params),
                     identity.ts, socket.ts
    http/            app.ts, api.ts (health, composer routes, SSE), security.ts (CSP, admin guard)
    check/           checker.ts (worker pool), worker.ts, run.ts, vm-evaluator.ts, audition.ts
    conductor/       conductor.ts, accept.ts, compile.ts, context.ts (buildTurnContext), placement.ts,
                     keep.ts (Stay / Move on), arc.ts, mixer.ts, knobs.ts, ledger.ts, store.ts
    composer/        claude.ts, external.ts, scripted.ts (+ autopilot, arrange, carry, wishes),
                     reference.ts, prompt/ (brief, reference card, catalog digest), library/
  client/
    index.html main.ts
    engine/          engine.ts, boot.ts, sounds.ts, preload.ts, fetch.ts, scheduler.ts, timers.ts,
                     clock-sync.ts, performer.ts, score.ts, window.ts, envelope.ts, knobs.ts,
                     channels.ts, master.ts, riser.ts, meters.ts
    render/          protocol.ts, host.ts, worker.ts, renderer.ts, lathe.ts (+ geometry, surface,
                     sprites, feed, moments, flash, tiers, clock, tokens)
    room/            connection.ts (socket, hello/welcome, stores), mock.ts (?mock), identity.ts
    ui/              App.svelte, ListeningRoom.svelte, components/, stores.ts, tokens.css
  cli/               bside.ts (+ args, client, format): the external composer CLI
palette/             vendored maps, levels.json, catalog.json (generated)
scripts/             build-catalog.ts, render-audio.ts, gen-allowlist.ts
test/                vitest unit + integration, per module; test/fixtures; browser harnesses
e2e/                 Playwright tests (scripted driver, no API key needed)
legacy/              the proof of concept, for reference
```

## 15. Testing

- **Unit** (vitest): timeline, schedule and limits; the validator security suite (malicious and
  idiomatic corpora, `ENGINE_OWNED_KEYS` ⊆ denied); analyzer descriptors and density bombs; crowd
  aggregation scenarios (troll, sybils, split, whiplash, keep/move-on); conductor scheduling with a
  fake clock, checker and composer (lock rules, placement, carry/origin, jumps, deadlines, restarts);
  the Claude driver against a stubbed Anthropic client (tool loop, repair, refusal, timeout).
- **Integration**: boot the server with the scripted driver, connect socket.io clients, assert
  hello/welcome/schedule flow, rate limits, and composer API round trips.
- **End to end** (Playwright, headless Chromium, scripted driver — no API key): landing record spins,
  unlock starts the engine, events fire on the shared grid, the code view highlights, the pad and
  reactions round-trip, reduced motion works, the phone layout fits, no `{@html}` anywhere.
- **Audio QA**: `scripts/render-audio.ts` renders library sections offline in headless Chromium and
  checks peak, RMS and clipping; the catalog build uses the same renderer to measure sound levels.

## 16. Operating it

| Env | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables the Claude driver |
| `BSIDE_COMPOSER` | `claude` if a key is set, else `scripted` | Initial driver (`claude` without a key falls back to `scripted`) |
| `BSIDE_MODEL` | `claude-opus-5` | |
| `BSIDE_EFFORT_SECTION` | `medium` | Effort for section turns (`low` · `medium` · `high`) |
| `BSIDE_EFFORT_MOVEMENT` | `high` | Effort for movement turns (`medium` · `high` · `xhigh`) |
| `BSIDE_MAX_PLANS_PER_HOUR` | 90 | Hard budget on compose calls |
| `BSIDE_MAX_API_CALLS_PER_PLAN` | 8 | API round trips (auditions + commits) one plan may take |
| `BSIDE_AUTOPILOT` | — | `synth`: the autopilot uses only its synth ensembles (no sample downloads; offline rooms, e2e) |
| `BSIDE_ADMIN_TOKEN` | — | Guards `/api/composer/*` (≥ 16 chars; loopback-only in dev without it; disabled in production without it) |
| `BSIDE_SECRET` | generated into `$BSIDE_DATA_DIR/secret.key` (0600) | HMAC key for listener tokens (≥ 16 chars) |
| `BSIDE_TRUST_PROXY` | 0 | Reverse-proxy hops to trust for client addresses |
| `BSIDE_IPV6_PREFIX` | 48 | IPv6 prefix length treated as one network (per-network caps) |
| `BSIDE_MAX_SOCKETS_PER_NETWORK` | 64 | Concurrent sockets per network |
| `BSIDE_HOST` | `localhost` in dev, all interfaces in production | Listen address |
| `PORT` | 3000 | |
| `BSIDE_DATA_DIR` | `./data` | Session, ledger, identity, secret (outside served roots) |
| `BSIDE_CATALOG` | `palette/catalog.json` | Sound catalog |
| `BSIDE_SOURCE_URL` | this repository | Shown in the UI (AGPL-3.0 §13) |
| `BSIDE_LOG` | `info` | `debug` · `info` · `warn` · `error` · `silent` |
| `BSIDE_LOG_FORMAT` | `pretty` on a terminal, else `json` | One JSON object per line, or human-readable |
| `BSIDE_URL` | `http://localhost:3000` | Server the `bside` CLI talks to |

Cost is roughly one Claude call per 1–2 sections (1–3 minutes of music); nothing is spent while the
room is empty. Everything is AGPL-3.0-or-later, as Strudel is; a hosted room must offer its source,
which the UI links to.
