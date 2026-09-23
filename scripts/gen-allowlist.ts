// Generates src/strudel/allowlist.generated.json: the static allowlist shared verbatim by the
// server validator and the client compiler (ARCHITECTURE §11.1).
//
//   node --disable-warning=ExperimentalWarning --import ./src/server/node-hooks.ts scripts/gen-allowlist.ts
//
// Candidates are derived from the real exports of @strudel/core + mini + tonal (never from the
// browser, whose Pattern.prototype is widened by webaudio/draw/soundfonts). Everything denied is
// listed with the reason it is denied; the JSON is committed so both sides use the same list.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENGINE_OWNED_KEYS } from '../src/shared/limits.ts';

type Namespace = Record<string, unknown>;

const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  return fn().finally(() => {
    console.log = log;
    console.warn = warn;
  });
};

const [core, mini, tonal] = await quiet(() => Promise.all([import('@strudel/core'), import('@strudel/mini'), import('@strudel/tonal')]));

const exported: Namespace = { ...core, ...mini, ...tonal };
const PROTO = core.Pattern.prototype as Record<string, unknown>;

// ─── Denylist ─────────────────────────────────────────────────────────────────────────────────────
// Each entry: names (identifiers, methods, object keys and hap keys alike) and the reason.

const denied = new Map<string, string>();
const deny = (names: Iterable<string>, reason: string) => {
  for (const n of names) if (!denied.has(n)) denied.set(n, reason);
};

// Whole source modules whose exports are never part of a pattern expression.
const MODULE_DENIALS: [pkg: string, file: string, reason: string][] = [
  ['core', 'ui.mjs', 'touches the page DOM: backgroundImage() writes an attacker-chosen url() into #code (exfiltration via image fetch) — core/ui.mjs'],
  ['core', 'speak.mjs', 'drives window.speechSynthesis on every trigger — core/speak.mjs'],
  ['core', 'repl.mjs', 'REPL/scheduler plumbing, not a pattern function — core/repl.mjs'],
  ['core', 'cyclist.mjs', 'scheduler class — core/cyclist.mjs'],
  ['core', 'neocyclist.mjs', 'scheduler class — core/neocyclist.mjs'],
  ['core', 'evaluate.mjs', 'evaluates code / writes the global scope (evalScope copies exports onto globalThis) — core/evaluate.mjs'],
  ['core', 'logger.mjs', 'logging side channel (dispatches DOM events) — core/logger.mjs'],
  ['core', 'schedulerState.mjs', 'mutates the global scheduler state shared by every part (setCpsFunc, setPattern, setTriggerFunc…) — core/schedulerState.mjs'],
  ['core', 'impure.mjs', 'module-global timeline offsets depend on when each client first queried, so listeners diverge (timeline, reset_state) — core/impure.mjs'],
  ['core', 'util.mjs', 'plain JavaScript helpers (keyboard state, clocks, base64/hash codecs, curry/compose) rather than pattern functions — core/util.mjs'],
  ['core', 'drawLine.mjs', 'ASCII visualisation helper — core/drawLine.mjs'],
  ['mini', 'mini.mjs', 'mini-notation internals; write a "double-quoted" string instead (the transpiler emits m() itself) — mini/mini.mjs'],
  ['mini', 'krill-parser.js', 'mini-notation parser internals — mini/krill-parser.js'],
];

async function moduleExports(pkg: string, file: string): Promise<string[]> {
  const url = new URL(`../node_modules/@strudel/${pkg}/${file}`, import.meta.url);
  return Object.keys(await quiet(() => import(url.href)));
}
for (const [pkg, file, reason] of MODULE_DENIALS) deny(await moduleExports(pkg, file), reason);

deny(
  ['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
    'caller', 'callee', 'arguments', 'call', 'apply', 'bind', 'toString', 'valueOf', 'toLocaleString', 'hasOwnProperty',
    'isPrototypeOf', 'propertyIsEnumerable', 'then'],
  'prototype-chain / Function.prototype access: the only way from a Strudel value to Function() or a foreign receiver',
);
deny(
  ['eval', 'Function', 'globalThis', 'window', 'self', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'import', 'require', 'process', 'module', 'exports', 'global', 'top', 'parent', 'frames', 'opener', 'location',
    'navigator', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore', 'setTimeout', 'setInterval',
    'requestAnimationFrame', 'queueMicrotask', 'postMessage', 'Worker', 'SharedWorker', 'importScripts', 'Reflect',
    'Proxy', 'Object', 'Symbol', 'Promise', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp',
    'Buffer', 'Atomics', 'SharedArrayBuffer', 'WebAssembly', 'crypto', 'performance', 'console', 'alert', 'undefined',
    'NaN', 'Infinity', 'Error'],
  'JavaScript/browser global: part code may only reference Strudel functions',
);

// Code-execution and network sinks reachable through Strudel itself.
deny(['worklet', 'workletSrc', 'workletInputs'], 'stores workletSrc, which superdough compiles through kabelsalat into Function() — superdough.mjs:615-625');
deny(['bbexpr', 'byteBeatExpression', 'bbst', 'byteBeatStartTime'], 's("bytebeat") evaluates byteBeatExpression with new Function in the bytebeat worklet — superdough/worklets.mjs:884');
deny(['K', 'S', 'compileKabel'], 'kabelsalat DSL: the transpiler rewrites K(...) into worklet(...) → Function() — transpiler.mjs isKabelCall');
deny(['as'], 'writes arbitrary hap keys from a string (getControlName passes unknown names through), which smuggles workletSrc/byteBeatExpression past key checks — controls.mjs:2773');
deny(['hydra', 'initHydra', 'H'], 'initHydra({src}) imports a remote ES module — @strudel/hydra hydra.mjs:16-29');
deny(['samples', 'aliasBank', 'soundAlias', 'setSoundfontUrl', 'loadSoundfont', 'registerSound', 'registerSynthSounds', 'registerSoundfonts', 'loadCSound', 'loadOrc'],
  'changes remote fetch/eval sources (the soundfont loader eval()s fetched text — soundfonts/fontloader.mjs:24-31); the palette is fixed by the catalog');
deny(['source', 'src'], 'superdough calls value.source(t, value, …) as a function on every hap — superdough.mjs:549-551');
deny(['FX', 'fxr', 'FXr', 'FXrel', 'FXrelease'], 'per-hap effect chains: every FX entry builds its own reverb/delay/distortion nodes per hap and bypasses HAP_LIMITS — superdough.mjs:882-913');
deny(['lfo', 'env', 'bmod', 'modulate'], 'modulators can target gain/postgain with depthabs regardless of the fader, so a faded-out part still sounds — superdoughdata.mjs:10-11, controls.mjs:2875');
deny(['ch', 'channel', 'channels'], 'output channel routing is engine-owned');
deny(['nudge'], 'shifts trigger time per hap; timing is engine-owned');
deny(['orbit', 'o'], 'the conductor assigns each part instance its own orbit (reverb/delay bus + engine channel)');
deny(['duck', 'duckorbit', 'duckdepth', 'duckattack', 'duckonset', 'duckatt', 'duckons'], 'sidechain ducking is engine-owned (declare it with the part\'s duck field)');
deny(['bus', 'busgain', 'bgain'], 'bus routing is engine-owned');
deny(['analyze', 'fft'], 'creates analysers on the orbit; the engine owns metering');
deny(['color', 'colour', 'markcss', 'hsl', 'hsla'], 'visual styling of the code view is owned by the client (markcss injects CSS)');
deny(['cps', 'cpm', 'setcps', 'setCps', 'setcpm', 'setCpm'], 'tempo is set per section by the conductor (bpm); cpm() is a fast() in disguise — pattern.mjs:2047');
deny(['hush', 'all', 'each', 'repl', 'createClock', 'getTrigger'], 'REPL-level control over every running pattern');
deny(['p', 'q', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'],
  'REPL label/solo helpers; a part is exactly one expression and the room plays parts in parallel');
deny(['useRNG', 'withSeed'], 'switches or rewrites the random generator for every part (useRNG is global — signal.mjs:279; withSeed takes a raw seed callback)');
deny(['calculateSteps'], 'global switch shared by every part — pattern.mjs:33-37');
deny(['setStringParser'], 'makes every string a pattern globally; server and client must parse identically — pattern.mjs:39');
deny(['registerVoicings', 'addVoicings', 'setDefaultVoicings', 'voicingAlias', 'resetVoicings', 'setVoicingRange', 'voicingRegistry'],
  'mutates the global chord-voicing dictionaries shared by every part — tonal/voicings.mjs:84-248');
deny(['evaluate', 'evalScope', 'strudelScope', 'register', 'createParam', 'createParams', 'registerControl', 'registerMultiControl', 'isControlName', 'getControlName', 'compose', 'curry', 'pipe'],
  'code evaluation / scope and registry mutation');
deny(['whenKey', 'keyDown', 'mouseX', 'mouseY', 'mousex', 'mousey'], 'reads the listener\'s keyboard or pointer, so every client plays something different — signal.mjs:176-182, 925-970');
deny(['ref', 'signal'], 'raw accessor/time callbacks (ref reads live state at query time, so clients diverge) — pattern.mjs:3473, signal.mjs:18');
deny(['withValue', 'fmap', 'withHap', 'withHaps', 'filter', 'filterHaps', 'filterValues', 'filterWhen', 'bind', 'innerBind', 'outerBind',
  'squeezeBind', 'stepBind', 'polyBind', 'focusBind', 'func', 'arpWith', 'onTrigger', 'onTriggerTime', 'draw', 'onPaint', 'log', 'logValues'],
  'raw per-hap/per-value callbacks (onTriggerTime runs window.setTimeout — pattern.mjs:3388); use pattern functions such as .every/.sometimes/.off instead');
deny(['applyN'], 'applies a function n times in a loop, multiplying density exponentially (applyN(16, x => x.ply(2))) — pattern.mjs:2430');
deny(['bjork', 'bjorklund'], 'array-argument euclid helpers the density checker cannot bound; use .euclid(k, n) / .euclidRot(k, n, r) or "x(k,n)"');
deny(['pace', 'steps', 'extend', 'replicate', 'expand', 'contract', 'shrink', 'shrinklist', 'grow', 'tour', 'zip', 'take', 'drop',
  'poly', 'stepalt', 'polymeter', 'pm', 's_add', 's_alt', 's_cat', 's_contract', 's_expand', 's_extend', 's_polymeter', 's_sub',
  's_taper', 's_taperlist', 's_tour', 's_zip'],
  '*Experimental* stepwise functions whose event density depends on runtime step counts (pace → fast(target/steps), polymeter/zip → lcm of step counts); use mini-notation {a b c, d e}%n — pattern.mjs:2804-3268');
deny(['drawLine', 'unjoin'], 'debugging/visualisation or pattern-of-patterns internals');
deny(['zoomArc', 'zoomarc', 'compressSpan', 'compressspan', 'focusSpan', 'focusspan'], 'take TimeSpan objects; use zoom(b, e) / compress(b, e) / focus(b, e)');
deny(['tag', 'label', 'activeLabel', 'setContext', 'withContext', 'stripContext', 'withLoc', 'withSteps', 'setSteps', 'hasSteps'],
  'hap context/metadata is owned by the engine (locations, tags, labels)');
deny(['query', 'queryArc', 'firstCycle', 'firstCycleValues', 'showFirstCycle', 'splitQueries', 'withQuerySpan', 'withQuerySpanMaybe',
  'withQueryTime', 'withHapSpan', 'withHapTime', 'withState', 'appBoth', 'appLeft', 'appRight', 'appWhole', 'bindWhole', 'join',
  'innerJoin', 'outerJoin', 'squeezeJoin', 'resetJoin', 'restartJoin', 'stepJoin', 'collect', 'defragmentHaps', 'sortHapsByPart',
  'onsetsOnly', 'discreteOnly', 'removeUndefineds', 'getRandsAtTime', 'isPattern', 'reify', 'parray', 'sequenceP'],
  'Pattern internals (querying, joins, hap plumbing) rather than musical API');
deny(['pianoroll', 'punchcard', 'scope', 'tscope', 'fscope', 'spectrum', 'spiral', 'wordfall', 'pitchwheel', 'animate', 'barchart', 'strudelTheme'],
  'visuals are owned by the client (and are browser-only Pattern.prototype extensions)');
deny(['dough', 'supradough', 'soundfont', 'webaudio', 'superdough', 'csound', 'serial', 'mqtt', 'midi', 'osc', 'midin', 'midikeys',
  'slider', 'sliderWithID', 'setGainCurve', 'setDefaultValue', 'resetGlobalEffects', 'setMaxPolyphony', 'setMultiChannelOrbits',
  'getAudioContext', 'initAudio', 'initAudioOnFirstClick'],
  'browser-only output/widget/audio-engine API; the engine owns audio');
deny(['ccn', 'ccv', 'control', 'ctlNum', 'midichan', 'midicmd', 'midibend', 'miditouch', 'midiport', 'nrpnn', 'nrpv', 'progNum',
  'sysex', 'sysexid', 'sysexdata', 'midimap', 'defaultmidimap', 'polyTouch', 'songPtr', 'oschost', 'oscport'],
  'MIDI/OSC output is not part of the product');

// Any control that writes a key the engine owns (aliases included: o → orbit, duck → duckorbit…).
const MULTI_VALUE = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
function keysWrittenBy(name: string): string[] {
  const keys = new Set<string>([core.getControlName(name)]);
  for (const arg of [0.5, MULTI_VALUE]) {
    try {
      const pat = core.pure({}) as unknown as Record<string, (v: unknown) => { firstCycleValues: unknown[] }>;
      const v = pat[name]!(core.pure(arg)).firstCycleValues[0];
      if (v && typeof v === 'object') for (const k of Object.keys(v)) keys.add(k);
    } catch {
      /* some controls reject these probe values */
    }
  }
  return [...keys];
}

const protoNames = Object.getOwnPropertyNames(PROTO);
const controlNames = [...new Set([...Object.keys(exported), ...protoNames])].filter((n) => core.isControlName(n)).sort();
const writes: Record<string, string[]> = {};
for (const name of controlNames) {
  writes[name] = keysWrittenBy(name);
  const bad = writes[name].find((k) => ENGINE_OWNED_KEYS.has(k) || (denied.has(k) && k !== name));
  if (bad) deny([name], denied.get(bad) ?? `writes the engine-owned hap key "${bad}"`);
}
for (const key of ENGINE_OWNED_KEYS) if (!denied.has(key)) deny([key], 'engine-owned hap key (src/shared/limits.ts ENGINE_OWNED_KEYS)');

// ─── Allowed sets ─────────────────────────────────────────────────────────────────────────────────

const isInternal = (n: string) => n.startsWith('_') || /^[A-Z]/.test(n);
const isPatternFunction = (v: unknown) => typeof v === 'function' || core.isPattern(v);

const globals = Object.keys(exported)
  .filter((n) => !isInternal(n) && !denied.has(n) && isPatternFunction(exported[n]))
  .concat('knob')
  .sort();

const methods = protoNames
  .filter((n) => {
    if (isInternal(n) || denied.has(n)) return false;
    const d = Object.getOwnPropertyDescriptor(PROTO, n)!;
    return typeof d.value === 'function' || typeof d.get === 'function';
  })
  .sort();

const controls = controlNames.filter((n) => !denied.has(n));

// Composer accessors (pat.add.squeeze(...)) and their modes — pattern.mjs:1096-1150.
const OPERATORS = ['set', 'keep', 'keepif', 'add', 'sub', 'mul', 'div', 'mod', 'pow', 'log2', 'band', 'bor', 'bxor', 'blshift',
  'brshift', 'lt', 'gt', 'lte', 'gte', 'eq', 'eqt', 'ne', 'net', 'and', 'or'];
const OPERATOR_MODES = ['in', 'out', 'mix', 'squeeze', 'squeezein', 'squeezeout', 'reset', 'restart'];
for (const op of OPERATORS) if (!methods.includes(op)) throw new Error(`operator ${op} missing from Pattern.prototype`);

const version = (pkg: string) =>
  (JSON.parse(readFileSync(new URL(`../node_modules/@strudel/${pkg}/package.json`, import.meta.url), 'utf8')) as { version: string }).version;

const out = {
  $comment: 'Generated by scripts/gen-allowlist.ts from @strudel/core + mini + tonal. Do not edit by hand.',
  strudel: { core: version('core'), mini: version('mini'), tonal: version('tonal'), transpiler: version('transpiler') },
  globals,
  methods,
  controls,
  operators: OPERATORS,
  operatorModes: OPERATOR_MODES,
  scopeOnly: ['m'],
  denied: Object.fromEntries([...denied].sort(([a], [b]) => a.localeCompare(b))),
};

const target = fileURLToPath(new URL('../src/strudel/allowlist.generated.json', import.meta.url));
const text = JSON.stringify(out, null, 1) + '\n';
if (process.argv.includes('--check')) {
  // CI: fail when the committed allowlist no longer matches what the installed Strudel produces.
  if (readFileSync(target, 'utf8') !== text) {
    console.error(`${target} is out of date; run scripts/gen-allowlist.ts`);
    process.exit(1);
  }
  console.log('allowlist is up to date');
} else {
  writeFileSync(target, text);
  console.log(`wrote ${target}: ${globals.length} globals, ${methods.length} methods, ${controls.length} controls, ${denied.size} denied`);
}
