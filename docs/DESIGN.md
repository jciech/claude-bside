# B-Side design: the Cutting Room

The room is a record that Claude is cutting live. One revolution of the platter is one bar, so the
record turns at `BPM / 4` rpm — 120 BPM is 30 rpm, 133⅓ BPM is exactly 33⅓. Each movement fills one
**side**; each section is a **track**, cut as a band of the spiral; every part leaves its own glyph
in the groove; listener reactions are **etched** into the rim. The one metaphor explains time,
structure, Claude's role and the audience at once — and it is cheap to draw, because history
accumulates into a texture.

| Term | In the product | Data |
|---|---|---|
| Side | A movement (6–20 min). Side A, B, C… per session | `MovementInfo.side` |
| Track | A section, with Claude's title | `SectionProgram.name` |
| Groove | The inward spiral; 1 revolution = 1 bar | cycle → angle |
| Needle | Where the music is — on the record *and* on the pull pad | `now()`, `CrowdFrame.needle` |
| Pull | Where the room leans | `CrowdFrame.pull` |
| Pre-echo | Ghosts of the next bar approaching the needle | `engine.query()` lookahead |
| Land | The glossy gap between tracks | section boundaries |
| Liner notes | Claude's voice | `LinerNote` |
| Etch | A reaction, scratched into the rim | `CrowdFrame.etches` |

No skeuomorphic chrome: no wood grain, no turntable plinth. Lacquer, paper, light.

## Tokens

### Colour (dark "Lathe" theme; contrast computed against lacquer surfaces)

| Token | Hex | Role |
|---|---|---|
| `--lacquer-0` | `#07060A` | page / stage |
| `--lacquer-1` | `#0E0C12` | platter, inputs |
| `--lacquer-2` | `#16131C` | panels |
| `--lacquer-3` | `#221E2A` | hover, raised |
| `--groove` | `#332D3E` | hairlines (decorative only) |
| `--edge` | `#756C80` | borders of interactive controls (≥ 3.27:1) |
| `--paper` | `#EFE7D6` | primary text, the label |
| `--paper-2` | `#C9C0AE` | secondary text |
| `--paper-3` | `#948B7B` | muted text (≥ 11 px) |
| `--clay` | `#E27C5C` | **Claude only**: stylus, liner-note rule, primary CTA |
| `--clay-2` | `#F2A488` | Claude's small text, acknowledgements |
| `--clay-ink` | `#2A120A` | text on clay |
| `--focus` | `#FFFFFF` | 2 px focus ring, 3 px offset |
| label paper | `#ECE2CC` | the record label (title `#1C140D`) |

**Voice spectrum**, ordered by register so colour itself says low vs high (`ROLE_FAMILY` in
`src/shared/music.ts` maps part roles to these):

| Family | Hex | Roles | Glyph (never colour alone) |
|---|---|---|---|
| `--v-kick` | `#FF5A4E` | kick | ● filled circle |
| `--v-bass` | `#FF9A3C` | bass | ▬ capsule |
| `--v-snare` | `#FFD447` | snare, perc, breaks | ▲ triangle |
| `--v-hat` | `#C6F35E` | hats | ▏ thin bar |
| `--v-lead` | `#45E3C2` | lead, vox | ◆ diamond |
| `--v-keys` | `#58A8FF` | chords, arp | ☰ stacked bars |
| `--v-pad` | `#A08BFF` | pad | ○ ring |
| `--v-fx` | `#FF78D6` | texture | ✱ |

Rules: clay is never a voice colour; voice colours never carry chrome text; listener identity hues
are a separate set (`hsl(h 55% 70%)`, 12 hues); there is no red/green semantics anywhere — errors use
clay-2 + icon + words. The record's sheen tint follows the needle: dark→bright moves hue violet
(265°) → gold (40°); calm→intense raises sheen intensity 0.07 → 0.14.

`prefers-contrast: more` promotes `--paper-3` to `--paper-2`, hairlines to `--edge`, disables sheen.
`forced-colors` hides the canvas (it is decorative) and uses system colours.

### Type

| Family | Where | Why |
|---|---|---|
| **Anybody Variable** (`wdth` 50–150, `wght` 100–900) | wordmark, track titles, label, CTA | Width is expressive: `font-stretch: calc(60% + var(--energy) * 80%)` — titles widen as the music heats up (never faster than one bar; fixed-size boxes) |
| **Newsreader Variable italic** | liner notes, landing lede | Always and only Claude's words |
| **JetBrains Mono Variable** | code, data, meta, UI labels | Legible code at 12 px, tabular numbers |

Self-hosted via `@fontsource-variable/*` (≈ 162 kB latin), Anybody and JetBrains Mono preloaded.
Scale: `--t-xs` 11 px (uppercase meta, tracking .12em) · `--t-sm` 13 · code 12 (13 ≥ 1440 px) ·
`--t-base` 15 · `--t-md` clamp(17–20) · `--t-lg` clamp(22–28) · `--t-xl` clamp(28–40) · `--t-2xl`
clamp(44–88) wordmark. The wordmark pairs "CLAUDE" condensed with "B‑SIDE" expanded — that contrast
is the brand's typographic signature.

### Space, shape, motion

4 px base (4, 8, 12, 16, 20, 24, 32, 48, 64); 16 px mobile gutter. Radii 6 (controls), 12 (panels,
pad), pill (chips). Targets ≥ 48 px in the dock, ≥ 44 px elsewhere. No cards in cards: rails are
separated by hairlines.

Motion is in **musical time**. The clock writes `--beat` and `--bar` (ms) on tempo changes.

| Token | Value | Use |
|---|---|---|
| `--env-hit` | 0 attack, 180 ms decay, `cubic-bezier(.1,.9,.2,1)` | button presses |
| `--env-pluck` | 10 ms attack, 1 beat decay | tallies, meters, chips |
| `--env-swell` | 1 bar in / out | voice chips entering/leaving, label width |
| `--env-turn` | 2 bars | track change |

UI state changes caused by the music (vote closes, request "in the mix", track banner) **land on
the next downbeat**.

## The Lathe (main visual)

- Geometry: centre `(cx, cy)`, outer radius `R = 0.93·min(w,h)/2`, label radius `0.30R`. The
  groove spirals inward over the side's planned bars: `r(c) = 0.955R − (c − side.start)·pitch −
  lands(c)·landW`, `landW = 0.012R`. Record-space angle `a(c) = −2πc`; the platter rotates clockwise
  by `2π·c_now`; the stylus is fixed at 12 o'clock, so the future approaches from the left.
- History is **texture**, detail lives at the **needle**: individual bars are sub-pixel on phones,
  tracks read as bands of colour.
- Layers, back to front: platter (radial lacquer gradient, rim highlight) → **archive** (an
  accumulating texture; glyphs imprinted once when their onset passes; one rotated draw per frame)
  → **loupe** (a dark annular lens −63°…+40° around the stylus with five staff arcs at the lane
  offsets, the centre one clay) → **pre-echo** ghosts for the next bar, alpha `(1−ahead)^1.2` →
  **blooms** for sounding events, collapsing into the groove over 0.9 s, sized by part loudness →
  **label** (paper disc, rotating rim text "CLAUDE B‑SIDE · SIDE B · 120 BPM ·", clay off-centre
  spindle hole; the title is a crisp non-rotating DOM overlay) → **etches** (cream dots at the rim
  drifting out over 2.6 s, leaving a permanent tick) → **sheen** (a fixed two-lobe highlight the
  record turns under) → **tonearm + stylus** (clay glow following master RMS; the arm walks inward
  as the side fills).
- Glyph grammar per family (archive glyph / bloom / lane): kick = radial notch, big bloom + platter
  thump (scale 1.006) / lane −0.42; snare = short thick arc / +0.18; hat = dot, sparkle / +0.42;
  bass = arc 85 % of note length / by pitch (low); keys = short arcs per chord tone / by pitch;
  pad = faint wide wash (α 0.045), soft bloom sized by loudness / by pitch; lead = arc 60 % of
  duration, bright bead / by pitch (high); fx = dot, dust / +0.35.

### Musical states

| Moment | Visual |
|---|---|
| Part enters | Glyphs appear in the pre-echo a bar before they're audible ("you can see the bass coming"); legend chip swells in; code row slides in with fresh ink |
| Part leaves | Glyph alpha follows its level; chip dims with a strikethrough; code row fades after |
| Code changes | Changed characters get fresh ink (clay 16 % tint + underline) that dries over 4 bars |
| Track change | A land (glossy band), the label title wipes on the downbeat, a liner-note card slides in |
| Build | Lens widens (spread 0.20 → 0.26 R), sheen brightens, pre-echo extends to 2 bars, title widens |
| Drop | One shockwave ring label → rim over 1 beat; label inverts clay-on-ink for 1 bar. Never strobes |
| Breakdown | Lens narrows, ghosts dim to 40 %, sheen desaturates, pad washes rise |
| Silence | The platter keeps turning, the stylus lifts 6 px, the label shows "— listening —" |
| Part error | Its code row shows "muted: …" (clay-2 + icon); chip dashed; the rest plays |
| Disconnected | The record continues on the client clock; "reconnecting · still playing" |

### Tiers

| Tier | When | Renders |
|---|---|---|
| Full | worker frame p95 ≤ 12 ms | everything, DPR ≤ 2 |
| Lite | over budget | no grain/magnification, DPR ≤ 1.5 |
| Calm | `prefers-reduced-motion` or the "Calm visuals" toggle | the platter does not rotate; a stylus dot orbits the static record; no blooms/thump/shockwave; ≤ 30 fps |
| Paused | "Pause visuals", hidden tab | no canvas work |

Downgrade one tier when worker p95 > 20 ms for 3 s, > 2 long tasks in 10 s, or any scheduler skip;
upgrade after 60 s healthy. The user's choice always wins. A flash limiter is always on: ≤ 2
large-area luminance transitions per second, drops ≤ 1 per 2 s, no saturated full-field red.

The renderer never shares a thread with the audio scheduler (measured: main-thread rendering cost
586–695 ms/s and caused scheduler skips under throttling; in a worker, 53 ms/s and zero skips).

## Layout

**Desktop ≥ 1200 px** — the whole room in one viewport (`100dvh`), rails scroll internally.
Columns `minmax(320px,400px) | 1fr | minmax(280px,340px)`:

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ (◉) B-SIDE     SIDE B · TRACK 3  GLASS HARBOUR  120 bpm · D dorian · bar 69   ● 23   ⚙ 🔊 │
├─────────────────────┬─────────────────────────────────────────────┬───────────────────────┤
│ LINER NOTES         │                                             │ THE PULL drag to lean │
│ ● Claude · bar 64   │                 the record                  │ [ pad: dark↔bright,   │
│ "Bringing the kick  │           (label, loupe, tonearm)           │   calm↔intense ]      │
│  in under…"         │                                             │ ● drifting brighter…  │
│ ↳ answering a wish  │                                             ├───────────────────────┤
├─────────────────────┤                                             │ NEXT MOVE closes b.72 │
│ THE CODE  ⧉ follow  │                                             │ [A] … ▓▓ 54%          │
│ ● KICK │ kick: …    │   [● kick][▏hats][▲snare][▬bass][☰keys]…    ├───────────────────────┤
│ ▬ BASS │ bass: …    │                                             │ ASK CLAUDE  7 waiting │
├─────────────────────┴─────────────────────────────────────────────┴───────────────────────┤
│                [🔥 Yes]   [◎ Stay]   [→ Move on]   [〰 Too much]                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

**Tablet 820–1199 px** — record centre-left; one right rail with tabs (Notes & Code · Pull · Vote ·
Ask); dock at the bottom. **Phone < 820 px** — record full width at the top, legend scrolls
horizontally below it, one panel at a time via a segmented tab bar (Code · Pull · Vote · Ask, Pull
default), dock in the thumb zone respecting the safe area.

## Components

| Component | Notes |
|---|---|
| `TopBar` | brand mark, track + side, bpm · key · bar, presence, volume, settings |
| `Record` | canvas host for the Lathe worker + DOM label overlay (title, side) |
| `NowPlayingSummary` | visually hidden text alternative (track, key, BPM, each part's instrument and state), key `?` |
| `Legend` / `VoiceChip` | parts at a glance; swatch opacity follows loudness; toggles a **local** mute (personal mix, never shared) |
| `CodeView` / `PartRow` | one row per part: gutter (glyph, name, meter) + `id: code`; sounding mini-notation atoms lit in the voice colour (background, `#0B0A0E` text), control atoms underlined; highlights last `max(duration, 120 ms)`; fresh ink; "Copy" and "Open in strudel.cc"; follow mode |
| `LinerNotes` / `NoteCard` | a timeline, not toasts; the current note Newsreader italic with a clay rule; past notes smaller with bar stamps; "↳ answering …" in clay-2 |
| `CueChip` | "drop in 6 bars" from the committed schedule (next section role/start) |
| `PullPad` | others as identity-hue dots that school gently; you as a white ring; the pull as a soft field + dashed ring; the needle as a clay dot with a trail joined to the pull by a dashed tension line; status line in words; keyboard = two sliders with verbal `aria-valuetext`; pointer drag with `touch-action:none`, tap-to-place; sends ≤ 1 Hz while dragging + once on release |
| `ReactionDock` | Yes (🔥 `fire`), Stay (`keep +1`), Move on (`keep −1`), Too much (😣 `harsh`); shortcuts 1–4 outside inputs; a draining cooldown ring; your etch appears at the rim |
| `VoteCard` | fieldset/legend radio group, bars filling on tally, closes at a bar; the winner flies into the liner notes on the downbeat |
| `AskBox` / `AskList` | 140 chars, 1 per minute; your raw text visible only to you; others see Claude's paraphrase once decided; lifecycle chips |
| `Landing` | the room's record spins silently **in sync** before the unlock; "● LIVE NOW · 23 IN THE ROOM"; "Drop the needle" — the unlock happens synchronously in its click handler; audio fades in from the next downbeat over one bar |
| `Settings` | volume, calm visuals, pause visuals, keyboard shortcuts toggle |
| `SourceLink` | AGPL-3.0 §13 source link in the footer/settings |

## Accessibility

Canvas is `aria-hidden` with `NowPlayingSummary` as its text alternative; landmarks (`header`,
`main`, labelled `aside`s, `nav` for the dock) and a skip link to the pull pad; all text ≥ AA on every
surface; interactive borders ≥ 3:1; a 2 px white focus ring; everything keyboard-operable; "Pause
visuals" and "Calm visuals" (reduced motion defaults to Calm); the flash limiter; the pad has
tap-to-place and slider alternatives; polite live regions only (newest liner note at most once per
8 bars, your own request status, vote results, track changes); plain-language status ("drifting
brighter over ~8 bars") — no jargon like "energy budget".
