# B-Side

**A record Claude is cutting live.** B-Side is a listening room where Claude composes music as
[Strudel](https://strudel.cc) code, every listener's browser plays it in sync, and the room steers
where it goes — pulling the mood brighter or darker, calmer or more intense, asking for things,
voting on what comes next.

The music is performed in your browser from code, not streamed as audio: you can watch the exact
Strudel that is playing, with the sounding notes lit up as they play, while the record turns — one
revolution per bar.

## How it works

- **Claude composes** one or two sections at a time (16–64 bars each), as structured plans of
  Strudel parts with levels, entries and exits, knobs, automation and transitions. It auditions its
  code against a real Strudel evaluator before committing, and writes liner notes explaining what
  it's doing and whose request it is answering.
- **The conductor** (a deterministic server) validates every line of code against a strict
  allowlist, measures what it actually sounds like (density, register, brightness, intensity — from
  the events, never from guesses), enforces musical and safety rules, and schedules sections on a
  shared timeline. If Claude is late, the music keeps going; if it fails, an autopilot continues.
- **Every browser performs** the same timeline, synced to the server clock to within milliseconds,
  with smooth fades, crossfades, risers and a limiter — and a record that draws each part into the
  groove as it plays.
- **The room steers** through a shared pull pad (dark ↔ bright × calm ↔ intense), Stay / Move on,
  reactions, requests and votes. Influence is gradual and shared: the mixer answers within a bar or
  two, the structure at the next section, and no single listener can yank it around.

The design is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (system),
[`docs/DESIGN.md`](docs/DESIGN.md) (visual identity) and [`docs/COMPOSING.md`](docs/COMPOSING.md)
(writing music for the room, by hand or with Claude).

## Running it

Requires Node ≥ 22.18.

```bash
npm install
npm run dev            # http://localhost:3000 — server + client with hot reload, one process
```

Without an API key the room runs on the **scripted autopilot** (a library of verified sections).
To let Claude compose:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npm run dev
```

Production:

```bash
npm run build
BSIDE_ADMIN_TOKEN=... npm start
```

## Composing by hand

The composer is an interface with three drivers — Claude, the scripted autopilot, and **external**:
anyone (you, a script, Claude Code) can compose over HTTP with the same context and the same
checks Claude gets.

```bash
npm run bside -- driver external     # hand the room to the external driver
npm run bside -- context             # what a composer sees right now
npm run bside -- audition --role bass --code 'n("0 3 5 7").scale("D2:dorian").s("sawtooth").lpf(600)'
npm run bside -- commit plan.json --next
npm run bside -- watch               # planning requests and section starts, live
```

See [`docs/COMPOSING.md`](docs/COMPOSING.md) for the plan format and a worked session.

## Development

```bash
npm test               # unit + integration tests (vitest)
npm run test:e2e       # end-to-end in headless Chromium (scripted composer, no API key)
npm run typecheck      # tsc + svelte-check
npm run catalog        # rebuild the sound catalog from pinned sample repositories
```

| Env | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables the Claude composer |
| `BSIDE_COMPOSER` | `claude` if a key is set, else `scripted` | Initial composer driver |
| `BSIDE_MODEL` | `claude-opus-5` | |
| `BSIDE_MAX_PLANS_PER_HOUR` | 90 | Budget on Claude compose calls |
| `BSIDE_ADMIN_TOKEN` | — | Guards the composer API (required in production) |
| `BSIDE_TRUST_PROXY` | 0 | Reverse-proxy hops to trust for client addresses |
| `BSIDE_DATA_DIR` | `./data` | Session and ledger persistence |
| `PORT` | 3000 | |

The original proof of concept lives in `legacy/` for reference.

## License and credits

AGPL-3.0-or-later, as Strudel is; a hosted room must offer its source (the room links to it).
Built on [Strudel](https://strudel.cc) by Felix Roos and contributors. Sounds come from the
TidalCycles Dirt-Samples, tidal-drum-machines, the Versilian Community Sample Library (CC0), the
Salamander piano, the mridangam set, switchangel's breaks and pads, clean-breaks, AKWF wavetables and
General MIDI soundfonts — see [`palette/README.md`](palette/README.md) for sources, pinned commits and
attribution.
