# Composing for the room

The composer is an interface, not a model. Claude is one driver; the scripted autopilot is another;
the **external** driver lets anyone compose over HTTP: you at a terminal, a script, or a coding agent
such as Claude Code. Every driver gets the same `TurnContext`, the same `audition` check and the same
`commit` gate, so a hand-written plan is held to exactly the rules Claude's are.

This guide covers the workflow, the plan format and the API. The composer's full brief (what the
room values, how a plan becomes sound, every rule the conductor enforces, the Strudel reference card
and the sound catalog) is what Claude reads each turn; print it with `npm run bside -- reference`.
The schema is `src/shared/plan.ts`; the API is `src/shared/composer-api.ts`.

## Quick start

```bash
npm run dev                                  # the room, on the autopilot if there is no API key
npm run bside -- status                      # driver, pending request, what's playing, horizon
npm run bside -- driver external             # you compose now; a "handoff" request opens
npm run bside -- watch                       # in a second terminal: requests, sections, starts
npm run bside -- context > ctx.json          # what a composer sees right now
npm run bside -- audition plan.json          # check every section's new parts
npm run bside -- commit plan.json --request pending
```

Open http://localhost:3000 to hear it. In development the composer API accepts loopback requests
without a token. Against a deployed room, set `BSIDE_URL` and `BSIDE_ADMIN_TOKEN` (or pass `--url`
and `--token`). In production the API is off unless `BSIDE_ADMIN_TOKEN` is set.

## The loop

1. **A request arrives.** The conductor asks for a plan when committed music runs short, when the room
   votes to move on, when a request gathers support, when a fork closes, and so on. `watch` prints it.
   `status` shows it as `pending`, with its reasons, the cycle where your first section will start,
   and two deadlines.
2. **Read the context.** `bside context` is the pending request's `TurnContext` (or a fresh preview if
   nothing is pending). The useful parts:
   - `now` and `committed`: what is playing and what is locked, with every part's code, level,
     knobs and `patternBarAtEnd`.
   - `expected`: the conductor's arc suggestion for each section you are asked to write.
   - `crowd`: the pull pad, Stay / Move on, reactions, requests.
   - `novelty`: sounds on cooldown, and the crate of sounds to dig into.
   - `rules` and `rules.budget`: tempo range, section lengths, peak and floor budgets.
   - `memory`: the last rationale, the movement's form sketch and its motifs.
3. **Write a plan**: one or two sections (`request.sectionsWanted`).
4. **Audition** anything new. See [Reading an audition](#reading-an-audition).
5. **Commit** with `--request pending` to fulfil the request. If the plan is rejected, the issues say
   exactly what to fix; fix it and commit again.

**Deadlines.** Commit before the soft deadline and your plan lands where the request intended. After
the hard deadline the autopilot fills the gap. A later commit is still accepted; its mode decides
where it lands. If you miss the soft deadline, the last committed section **vamps** (its last 4–8 bars
loop) until you commit or the hard deadline passes. Build, intro, outro and transition sections
can't vamp.

**Commit modes.** You can commit at any time, with or without a pending request:

| Flag | Mode | Placement |
|---|---|---|
| (none) | `horizon` | After the locked sections, replacing the provisional ones the request names. |
| `--next` | `next` | Replaces every unlocked section, starting at the first 4-bar line whose lock is still ahead. |
| `--now` | `now` | As soon as possible, with a forced cut. Listeners may not have preloaded the sounds (you get a `lead-time` warning). |

## A plan

This plan was committed by hand during development. It carries the pad and the sub bass from the
section before, brings in two sounds from the crate, and hands one knob to the room.

```json
{
  "sections": [{
    "name": "Bowed Strings, Small Hands",
    "role": "bridge",
    "bars": 16,
    "bpm": 70,
    "tempoRampBars": 0,
    "tempoRampAt": "start",
    "scale": "C:minor",
    "chords": null,
    "targets": {
      "intensity": { "start": 0.28, "end": 0.34 },
      "brightness": { "start": 0.42, "end": 0.5 },
      "density": { "start": 0.25, "end": 0.35 },
      "tension": { "start": 0.3, "end": 0.45 }
    },
    "transitionIn": { "type": "crossfade", "bars": 2 },
    "parts": [
      { "id": "pad", "role": "pad", "code": null, "restart": false, "chromatic": false, "level": 0.55,
        "enterBar": 0, "exitBar": null, "knobs": [], "automation": [], "duck": null },
      { "id": "sub", "role": "bass", "code": null, "restart": false, "chromatic": false, "level": 0.7,
        "enterBar": 0, "exitBar": null, "knobs": [], "automation": [], "duck": null },
      { "id": "bow", "role": "lead",
        "code": "n(\"<[0 ~ 2 ~] [4 ~ 3 2] [0 ~ ~ -1] ~>\")\n  .scale(\"C4:minor\")\n  .s(\"psaltery_bow\")\n  .attack(0.3)\n  .release(1.2)\n  .room(0.5)\n  .gain(0.7)",
        "restart": false, "chromatic": false, "level": 0.6, "enterBar": 4, "exitBar": null, "knobs": [],
        "automation": [{ "target": "level", "fromBar": 4, "toBar": 8, "from": 0.2, "to": 0.6, "curve": "linear" }],
        "duck": null },
      { "id": "hands", "role": "perc",
        "code": "s(\"darbuka*8\")\n  .n(\"<0 3 1 3>\")\n  .gain(\"[0.5 0.2 0.3 0.2]*2\")\n  .lpf(knob(\"tone\"))\n  .room(0.2)",
        "restart": false, "chromatic": false, "level": 0.5, "enterBar": 8, "exitBar": null,
        "knobs": [{ "name": "tone", "default": 3000, "min": 1200, "max": 8000, "follows": "brightness" }],
        "automation": [], "duck": null }
    ],
    "reprise": null,
    "publicNote": "A side road: the pad and sub keep breathing while a bowed psaltery sings over them, and hand drums join at bar 8."
  }],
  "movement": null,
  "fork": null,
  "requestDecisions": [],
  "motifs": [],
  "announcement": null,
  "rationale": "Bridge per the arc sketch: lower intensity, keep pad+sub continuous, two crate sounds in, the tone knob following the room's brightness."
}
```

Every field is required; the schema is strict, so use `null`, `[]` or `false` rather than leaving a
field out. The commit gate runs the same zod schema (`src/shared/plan.ts`), and the CLI validates
locally before sending.

### Sections

| Field | |
|---|---|
| `name`, `publicNote` | A track title (≤ 40 chars) and a liner note (≤ 280) shown to listeners at bar 0. Plain words only: no links, markup or angle brackets. |
| `role` | `intro` `groove` `build` `drop` `breakdown` `bridge` `interlude` `outro` `transition` `reprise`. |
| `bars` | 8, 16, 24, 32, 48 or 64 (1 bar = 1 cycle). Only transitions may be shorter than 16. |
| `bpm`, `tempoRampBars`, `tempoRampAt` | Within ±4 of the movement's centre. A change of more than 2 BPM needs a ramp of at least as many bars as BPM, at the section's `start` or into its `end`. |
| `scale`, `chords` | `"D:dorian"`, or alternating per bar: `"<D:dorian G:mixolydian>"`. Pitched parts are checked against the scale bar by bar. `chords` is only a note to the next turn. |
| `targets` | Spans `{start, end}` (0–1) for intensity, brightness, density and tension. They are measured from the events your code produces; a measured span more than 0.2 away draws a warning. |
| `transitionIn` | `cut` · `crossfade` (≤ 8 bars) · `riser` · `breath` (≤ 2 bars of silence) · `filter`. It applies to the parts that don't continue. |
| `reprise` | The id of an earlier section you're deliberately calling back to, or `null`. |

### Parts

| Field | |
|---|---|
| `id`, `role` | A stable lowercase id. **Reusing an id with `code: null` carries the part.** It keeps the same code and knobs, and unless `restart` is true it plays on as one unbroken instance through the boundary. Parts you don't list leave at bar 0. |
| `code` | One Strudel expression. See [Writing parts](#writing-parts). |
| `level` | A fader (0–1) applied after the code's own `.gain()`. The engine fades it smoothly, so change levels here rather than in code. |
| `enterBar`, `exitBar` | Score bars. A negative `enterBar` (down to −8) is a pickup that plays over the end of the previous section. The pattern isn't restarted at entry. |
| `knobs` | Declares every `knob("name")` the code reads: `{name, default, min, max, follows}`. With `follows` set to `brightness`, `intensity` or their negations, the room's pull pad moves the knob by up to half its range. |
| `automation` | Up to 6 lanes `{target: "level" \| "knob:<name>", fromBar, toBar, from, to, curve}`. Lanes on one target must not overlap. |
| `duck` | A sidechain: `{targets: ["bass", "pad"], depth, releaseSec}` pushes up to 3 other parts down when this one hits. |
| `chromatic` | Exempts a pitched part from the key-fit check (blue notes, approach tones). |

### The rest of the plan

- `movement` opens a new side: a tempo and tonal centre, groove, arc shape, a form sketch, a palette
  and up to 3 signature sounds. It's required when there is no movement yet or when the request's
  `kind` is `movement`. With `startsAtSection: 1`, your first section closes the old side.
- `requestDecisions` must decide **every** request in `crowd.requests`: `this-plan`, `next-movement`,
  `fork-option`, `merged` or `declined`. Each needs a `publicReply` that paraphrases the wish; never
  quote the listener.
- `fork` puts a 2–3 option vote to the room, only when `rules.forkAllowed`.
- `motifs` are named ideas that come back in `memory.motifs`. `rationale` is a private note to the
  next turn, whoever composes it.

## Writing parts

The reference card (`bside reference`) is the authority. These are the rules people trip on most:

- **1 cycle = 1 bar.** `s("bd*4")` is four on the floor. Tempo belongs to the section, so never write
  `setcps`/`setcpm`.
- **One expression, no plumbing.** No `$:` labels, `samples()`, `.orbit()` or `.duck()`: the
  conductor owns routing, loading and sidechains.
- **Double quotes are mini-notation**: `"<0 3 5 7>"`, `"bd [~ sd]"`, `"c3 e3 g3"`. Single quotes and
  backticks are not.
- **Pitch through the scale**: `n("0 2 4 7").scale("D3:dorian")` stays in key when the section's
  scale changes. Literal notes are checked for key fit.
- **Sounds are catalog ids.** They are listed in the reference and in `palette/catalog.json`, and the
  context's `novelty.crate` suggests some. Unknown sounds and out-of-range soundfont notes are errors,
  with a "did you mean".
- **Knobs before time.** A knob is sampled where `knob()` is applied, so put time transforms
  (`.slow`, `.fast`, `.early`, `.ply` …) before the knob-controlled method; otherwise they stretch its
  automation.
- **Gain-stage with `level`.** Give the code a sensible `.gain()` and do the mixing on faders and
  automation.

## Reading an audition

```bash
npm run bside -- audition --role bass --scale D:dorian --bpm 96 \
  --code 'n("0 ~ 0 3 ~ 5 ~ 7").scale("D2:dorian").s("sawtooth").lpf(knob("cut")).release(0.2)' \
  --knob cut=700:250:2400:brightness
```

You can pass `--code` for a single part, or a file: an `AuditionInput`, a bare parts array, or a
whole plan (each section's new parts are auditioned with that section's bpm and scale). For each part
you get:

- **errors**, which would reject the commit, and **warnings**, which wouldn't. Each has a rule id, a
  message and, where it helps, a line and column plus a hint ("`.reverb` → did you mean `.room`?").
- **a digest** measured from the events the code actually produces: events per bar, register,
  brightness, loudness, key fit, and which knobs change anything.

The section as a whole also gets checked: mix density, an invalid scale, timeouts. The exit code is
0 when every part passes and 1 otherwise, so the CLI works in scripts.

## Common rejections

| Rule | Meaning |
|---|---|
| `schema` | The JSON doesn't match the plan schema. The path names the field. |
| `request-closed` | The request's deadline passed, or another plan already fulfilled it. Re-read `context`; you can still commit without `--request`. |
| `stale-context` | Usually a warning: the schedule moved while you wrote, so some sections you meant to replace were already locked and kept. It's an error only if the schedule keeps changing during the check, in which case commit again. |
| `tempo` | A BPM jump without a long enough ramp, or outside the movement's ±4. |
| `key-fit` | A pitched part is less than 60 % in key (below 80 % is a warning). Fix the notes or mark it `chromatic`. |
| `carry` | `code: null` for an id that isn't in the previous section. |
| `knob-undeclared` | The code reads a knob the part doesn't declare. |
| `dramaturgy` | A peak or near-silence budget is exceeded, a build doesn't build, or a role repeats too often. `rules.budget` shows where you stand. |
| `similarity`, `cooldown`, `crate` | Novelty across movements. Inside a movement, repetition is free. |
| `request` | A request you were shown has no decision, is decided twice, or a decision is missing its `sectionIndex` / `mergedInto`. |
| `text` | A name, note, blurb or reply contains a link, markup, angle brackets or control characters. |
| `lead-time` | (warning) The section is placed too close for listeners to preload its sounds. |

## Scripting it

The CLI is a thin client over `/api/composer/*`. Everything it does, a script can do:

```bash
curl -s localhost:3000/api/composer/status
curl -s localhost:3000/api/composer/context
curl -s -X POST localhost:3000/api/composer/audition -H 'content-type: application/json' -d @audition.json
curl -s -X POST localhost:3000/api/composer/commit   -H 'content-type: application/json' \
  -d "{\"plan\": $(cat plan.json), \"requestId\": \"$REQ\"}"
curl -sN localhost:3000/api/composer/events          # SSE: request · status · section · revoke · started
```

Add `-H "authorization: Bearer $BSIDE_ADMIN_TOKEN"` against a deployed room. `commit` always returns
200; read `accepted`. `bside watch --json` prints one `{event, data}` object per line, so a composer
loop can be a few lines of shell or Node that reacts to `request` events.

### Handing the room to a coding agent

Claude Code (or any agent with a shell) can compose through the CLI with no API integration. Set
the driver to `external`, point the agent at this file and `bside reference`, and have it loop:
`watch` for a request, `context`, write a plan, `audition`, `commit --request pending`. That gives
you Claude composing without the room holding an API key, and it's a good way to try out prompt
or rule changes before they reach the built-in driver.

## Developing without an API key

- With no key, the room starts on the **scripted autopilot**: 31 verified library ensembles,
  re-keyed and re-tempoed to the current movement, with deterministic arrangement moves.
  `BSIDE_AUTOPILOT=synth` limits it to the 7 synth-only ensembles, for offline machines and the e2e
  suite (nothing to download).
- `BSIDE_COMPOSER=external` starts on the external driver, so nothing plays until you commit.
- `bside plan` asks the conductor to plan now; `bside driver scripted` hands the room back.
- State persists in `BSIDE_DATA_DIR` (`./data`). Delete it for a fresh room.
