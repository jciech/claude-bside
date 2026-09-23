# Implementation guide

How the code is organised: which module owns what, the factory each one exports, how they are wired,
and how each is tested. Read `docs/ARCHITECTURE.md` first. The contracts in `src/shared/*`,
`src/server/types.ts`, `src/client/engine/types.ts` and `src/client/render/protocol.ts` are
normative: both sides of a boundary are written against them.

## Changing a contract

Contracts change deliberately, in one commit that also updates:

- every implementation and consumer, including test fakes (`test/conductor/harness.ts`,
  `test/integration/harness.ts`, `test/composer/fixtures.ts`, `test/lathe/browser` and
  `src/client/room/mock.ts`);
- the fixtures (`test/fixtures/snapshot.json` is a valid `RoomSnapshot`; `catalog.small.json` is a
  valid `Catalog`);
- the docs that describe it (ARCHITECTURE, COMPOSING for anything a composer sees).

`npm run typecheck` catches most of the fallout. The composer's system prompt is prompt-cached, so
a change to the Plan schema, the reference card or the catalog digest costs one cache miss.

## Ground rules

- Keep each module inside the paths it owns (table below); tests go under `test/<module>/`.
- Node runs TypeScript directly (type stripping): imports carry explicit `.ts` extensions, only
  erasable syntax (no `enum`, `namespace`, parameter properties), `import type` for types.
- Server code that imports Strudel must be run with `--import ./src/server/node-hooks.ts` (the npm
  scripts do); worker threads call `registerStrudelHooks()` themselves and import Strudel
  dynamically. Under vitest, `vitest.config.ts` aliases `@kabelsalat/web`.
- Headless Chromium is available here (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). The sandboxed
  browser can't reach raw.githubusercontent.com directly (proxy CA): route those requests through
  Node (`page.route` → `fetch` → `route.fulfill`) when you need samples, or use synth-only material
  (`BSIDE_AUTOPILOT=synth`).
- Express's `sendFile` refuses paths containing a dot-directory, so the production server (and the
  e2e suite) can't serve from a checkout under e.g. `.claude/worktrees/`; copy the tree elsewhere to
  run e2e from a worktree, with a unique `E2E_PORT` and `CI=1`.
- No `{@html}`/`innerHTML` for any text that came from a listener or a composer.

## Ownership and factories

| Module | Owns | Tests |
|---|---|---|
| **strudel** | `src/strudel/**`, `src/server/check/**`, `scripts/gen-allowlist.ts` | `test/strudel/` |
| **palette** | `palette/**`, `scripts/build-catalog.ts`, `scripts/render-audio.ts`, `test/fixtures/catalog.small.json` | `test/palette/` |
| **room** | `src/server/main.ts`, `config.ts`, `log.ts`, `src/server/room/**`, `src/server/http/**` | `test/room/`, `test/integration/` |
| **conductor** | `src/server/conductor/**` | `test/conductor/` |
| **composer** | `src/server/composer/**`, `src/cli/**` | `test/composer/` |
| **engine** | `src/client/engine/**` | `test/engine/` (+ `browser/run.ts`) |
| **lathe** | `src/client/render/**` | `test/lathe/` (+ `browser/run.ts`) |
| **ui** | `src/client/index.html`, `main.ts`, `public/**`, `room/**`, `ui/**` | `test/ui/`, `e2e/` |
| **shared** | `src/shared/**` (the contracts) | `test/shared.test.ts`, `test/schedule.test.ts` |

### strudel

```ts
// src/strudel/catalog.ts — pure
export function parseCatalog(json: unknown): Catalog;                         // validates shape, throws on error
export interface SoundIndex {
  get(id: string): CatalogSound | undefined;                                  // by registered id or alias
  resolve(s: string, bank?: string): CatalogSound | undefined;                // applies bank like superdough: `${bank}_${s}`, lower-cased
  ids(): string[];
}
export function createSoundIndex(catalog: Catalog): SoundIndex;

// src/strudel/validate.ts — pure, isomorphic, ~1 ms
export interface ValidateResult { ok: boolean; errors: Issue[]; warnings: Issue[]; knobsUsed: string[] }
export function validatePart(code: string, opts: { knobs: string[] }): ValidateResult;

// src/strudel/compile.ts — isomorphic (browser: new Function; Node worker: vm)
export interface KnobBinder { (name: string): unknown /* a Pattern, e.g. signal(...) */ }
export interface CompiledPart { pattern: any /* Strudel Pattern */; miniLocations: { start: number; end: number }[] }
export function compilePart(code: string, opts: { knob: KnobBinder; evaluator?: (source: string, names: string[], values: unknown[]) => unknown }): CompiledPart;
export function allowedScope(): Record<string, unknown>;                      // exactly the allowlisted values + m

// src/strudel/guard.ts — isomorphic; installed on import (compile.ts imports it)
export function withQueryBudget<T>(limits: QueryLimits, fn: () => T, usage?: { calls: number; haps: number }): T; // throws QueryBudgetExceeded

// src/strudel/analyze.ts — isomorphic
export function analyzeSection(input: { parts: (CheckPartInput & { pattern: any })[]; bpm: number; scale: string | null; bars: number; index: SoundIndex }): {
  parts: { id: string; analysis: PartAnalysis; digest: PartDigest; instrument: string; errors: Issue[]; warnings: Issue[] }[];
  mix: MixAnalysis; fingerprint: SectionFingerprint; errors: Issue[]; warnings: Issue[];
};

// src/server/check/checker.ts
export function createChecker(opts: { catalog: Catalog; poolSize?: number; timeoutMs?: number; maxQueue?: number }): Checker;
```

The allowlist is generated in Node from core + mini + tonal (plus `knob`, `m`) minus the documented
denylist by `scripts/gen-allowlist.ts` into `src/strudel/allowlist.generated.json`; commit it. The
security corpus (malicious + idiomatic) lives in `test/strudel/`.

### room

```ts
// src/server/config.ts
export function loadConfig(env: NodeJS.ProcessEnv, argv: string[]): ServerConfig;
// src/server/log.ts
export function createLogger(scope: string): Logger;
// src/server/room/clock.ts
export function serverNow(): number;                                          // performance.timeOrigin + performance.now()
export function createRoomClock(opts: { timeline: Timeline; now?: () => number; timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }): RoomClock;
// src/server/room/crowd.ts — a Crowd plus the lifecycle only main.ts drives (CrowdRuntime in types.ts)
export function createCrowd(opts: { broadcaster: Broadcaster; config: ServerConfig; store: Store; log: Logger; now?: () => number; timers?: CrowdTimers }): CrowdRuntime;
// src/server/room/socket.ts
export function createRoomServer(http: HttpServer, config: ServerConfig): RoomServer;  // websocket only, same-origin, small messages
export function createBroadcaster(io: Server): Broadcaster;                   // emits to the 'live' room / a listener's sockets
export function attachRoom(io: RoomServer, deps: { crowd: Crowd; conductor: Conductor; clock: RoomClock; config: ServerConfig; log: Logger }): () => void;  // returns detach
// src/server/http/security.ts
export function clientAddress(source: { remoteAddress?: string; headers: Record<string, string | string[] | undefined> }, trustProxy: number): string;
export function securityHeaders(config: ServerConfig): RequestHandler;       // CSP etc. (strict in production)
export function adminGuard(config: ServerConfig): RequestHandler;
// src/server/http/api.ts
export function createApiRouter(deps: { conductor: Conductor; crowd: Crowd; clock: RoomClock; config: ServerConfig; log: Logger }): Router;
```

`main.ts` wires everything in this order: config → log → store (`createStore`) → catalog (read
`config.catalogPath`, `parseCatalog`) → checker → composers → clock → broadcaster → crowd →
conductor (`start()`) → `clock.start()` → `crowd.start({ cycle, needle })` → socket handlers
(`attachRoom`, keeping its detach function) → HTTP (static `/palette/*`, API, Vite middleware in dev
or `dist/client` in production) → listen.

The crowd's lifecycle belongs to `main.ts`; the conductor only sees a `Crowd` and never starts or
stops it, and the crowd never calls the conductor. `crowd.start(source)` runs the 250 ms pump: it
advances smoothing, emits a `crowd` frame built from `source.cycle()` and `source.needle()` (the
conductor's needle, passed in as a function) when it changed or every 5 s, coalesces fork tallies,
and every 5 s does housekeeping (request expiry and "not seen" notes, forgetting listeners gone
10 minutes, persisting listener trust once a minute). The conductor drives everything else: `tick()`
once per bar, `summary()` for each turn context (a pure read) and `markShown()` when Claude or the
external driver is actually handed a planning request.

Graceful shutdown, each step guarded: detach the room handlers → `crowd.stop()` → `conductor.stop()`
→ `clock.stop()` → `crowd.persist()` → `store.flush()` → `checker.close()` → Vite → close socket.io
and the HTTP server.

### conductor

```ts
// src/server/conductor/store.ts
export function createStore(dataDir: string, log: Logger): Store;
// src/server/conductor/context.ts
export function buildTurnContext(input: TurnContextInput): TurnContext;      // pure; define TurnContextInput here
// src/server/conductor/ledger.ts
export function createLedger(opts: { store: Store; log: Logger }): Ledger;
// src/server/conductor/conductor.ts
export function createConductor(deps: {
  clock: RoomClock; crowd: Crowd; checker: Checker; store: Store; log: Logger; config: ServerConfig; catalog: Catalog;
  composers: { claude?: Composer; external: Composer; scripted: ScriptedComposer };
  broadcaster: Broadcaster; ledger?: Ledger;
}): Conductor;
```

### composer

```ts
// src/server/composer/reference.ts
export function composerSystemPrompt(catalog: Catalog): string;              // stable, cacheable
export function renderTurn(context: TurnContext): string;                     // the per-call user message
// src/server/composer/claude.ts
export function createClaudeComposer(opts: { config: ServerConfig; catalog: Catalog; log: Logger; client?: AnthropicLike }): Composer;
// src/server/composer/external.ts
export function createExternalComposer(opts: { log: Logger }): Composer;
// src/server/composer/scripted.ts
export function createScriptedComposer(opts: { catalog: Catalog; checker: Checker; log: Logger }): Promise<ScriptedComposer>;
// src/cli/bside.ts — `npm run bside -- <command>`, talks to /api/composer/* (BSIDE_URL, BSIDE_ADMIN_TOKEN)
```

`AnthropicLike` is the minimal surface of the SDK client the driver uses, so tests can stub it.

### engine

```ts
// src/client/engine/engine.ts
export function createEngine(options: EngineOptions): Engine;
// src/client/engine/clock-sync.ts
export function startClockSync(probe: () => Promise<number>): ClockSync;
```

### lathe

```ts
// src/client/render/host.ts
export const createLathe: CreateLathe;
```

### ui

The Svelte app: `src/client/main.ts` mounts `ui/App.svelte`; `room/connection.ts` owns the socket
(websocket transport, hello/welcome, schedule/mixer/crowd/notes → stores, clock probes, heartbeat,
telemetry when sampled) and a **mock room** (`?mock` in the URL: plays `test/fixtures/snapshot.json`
advancing on a local clock, with fake crowd frames) so the whole UI can be developed and screenshot
without a server.

## Verifying beyond unit tests

```bash
npm run test:e2e                                             # the real server (scripted, synth-only) + the built client
node --disable-warning=ExperimentalWarning test/engine/browser/run.ts main sync bomb   # engine in Chromium: haps, gains, onsets, sync, density guard
node --disable-warning=ExperimentalWarning test/lathe/browser/run.ts all ./lathe-shots  # record screenshots per viewport × tier, frame-time budget
node --disable-warning=ExperimentalWarning scripts/record-room.ts --url http://localhost:3000 --minutes 5 --out room.webm
```

The engine harness plays `test/fixtures/snapshot.json` through a real `AudioContext` and asserts on
captured haps, channel gains and acoustic onsets; the lathe harness drives `createLathe` with a fake
engine and checks main-thread busy time and worker frame times. Neither is part of `npm test`: run
them when you touch the engine or the renderer.

`scripts/record-room.ts` joins a running room in headless Chromium, drops the needle and records what
the engine sends to the speakers (Opus/WebM), logging each track change with its timestamp. It
records in real time. Listen to the result: tests prove the timing and levels, not the music.
