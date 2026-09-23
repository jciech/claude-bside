# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

B-Side: a live listening room. A server-side **conductor** schedules **sections** of Strudel code
written by a **composer** (Claude via the API, the scripted autopilot, or an external driver over
HTTP); every listener's browser **performs** the same timeline in sync; the crowd steers. Read
`docs/ARCHITECTURE.md` before changing anything structural — it is the design, and the typed
contracts it points to are normative:

- `src/shared/*` — music conventions, timeline + schedule rules (lock points, score time), hap
  limits, plain-text rules, the Plan schema, section programs, the socket protocol, analysis types,
  the composer API, the catalog.
- `src/server/types.ts` — Checker, Composer, RoomClock, Crowd, Ledger, Conductor, Store.
- `src/client/engine/types.ts` — the performer engine (its header comment is normative).
- `src/client/render/protocol.ts` — the record renderer.

`docs/DESIGN.md` is the visual identity; `docs/IMPLEMENTATION.md` maps modules to owners and
factories.

## Commands

```bash
npm run dev          # server + Vite middleware on :3000 (one process)
npm test             # vitest
npm run test:e2e     # Playwright, scripted composer, no API key
npm run typecheck
npm run bside -- <status|context|reference|audition|commit|driver|plan|watch>
npm run catalog      # rebuild palette/ from pinned sample repositories
```

Node runs TypeScript directly (type stripping): imports carry `.ts` extensions; only erasable
syntax (no `enum`, `namespace`, parameter properties); `import type` for types. Anything that
imports `@strudel/core` in Node needs `--import ./src/server/node-hooks.ts` (the npm scripts do);
worker threads call `registerStrudelHooks()` themselves.

## Strudel facts that bite

- **1 cycle = 1 bar.** `cps = bpm / 60 / 4`. Never `bpm / 60`.
- Double-quoted strings are mini-notation; single-quoted strings are plain JS strings.
- `.gain()` *replaces*; to scale use `.velocity()`, `.postgain()` or `.mul(gain(x))`.
- `|` random choice is a parse error directly inside `<…>`; wrap it in `[…]`.
- Chords use Strudel spelling: `^7` (not `maj7`), `m7`, `7sus`… `chord().voicing()`.
- `.scale("C:minor")` with colons; `note("c3 e3").add(7)` is a silent no-op — do arithmetic on
  `n(...)` before `.scale()`, or use `.transpose()`.
- `queryArc` swallows query errors and returns `[]` — analysis queries use `pattern.query(State)`.
- Cold samples drop their first hit; the engine preloads each section's sounds.
- superdough has no limiter, `initAudio` never resumes the context and needs `maxPolyphony`;
  the engine handles all three.

The Strudel source for reference can live at `../strudel`. The GitHub mirror
(`tidalcycles/strudel`) now only contains a pointer to Codeberg, but its history still has the full
tree: `git clone https://github.com/tidalcycles/strudel ../strudel && git -C ../strudel checkout
84efa66` (June 2025). The exact versions this project pins are on npm (`@strudel/core` 1.2.6,
`@strudel/webaudio` 1.3.0, …); `npm pack` them to read their sources. If neither is available, ask
the user to fetch it.

## Security boundaries (don't weaken them casually)

- Composer code reaches every listener's browser. It passes the static allowlist in
  `src/strudel/allowlist.generated.json` on the server **and** the client; hap values are clamped by
  `sanitizeModelValue`; the production CSP restricts where anything can connect.
- Listener and composer text is plain text (`src/shared/text.ts`): never `{@html}` / `innerHTML`.
- Listener requests reach the composer only inside an untrusted-data block; client telemetry only
  as corroborated error codes.
- The composer API needs `BSIDE_ADMIN_TOKEN` in production.

## Code style

- Comment only non-obvious implementation details or workarounds; names should explain the rest.
- Keep modules inside their ownership boundaries (`docs/IMPLEMENTATION.md`); change a contract
  deliberately, in one place, and update its consumers and the docs together.
- Tests next to the behaviour they pin: `test/<module>/`. Browser behaviour is verified with
  Playwright against `/opt/pw-browsers` Chromium in this environment.
