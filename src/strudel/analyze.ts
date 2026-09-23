// Hap-level analysis of a section's parts as they will sound together: descriptors, limits, key fit,
// density, sounds and the novelty fingerprint. Measures the events patterns actually produce — never
// regexes over code. Queries with pattern.query(State) because queryArc swallows exceptions
// (core/pattern.mjs:414-420), which is how broken code used to become silent.
import * as core from '@strudel/core';
import type { Issue, MixAnalysis, PartAnalysis, PartDigest, SectionFingerprint, SoundUse } from '../shared/analysis.ts';
import { laneValue, lanesFor } from '../shared/automation.ts';
import type { CatalogSound } from '../shared/catalog.ts';
import { BLOCKED_SOUNDS, failingVariant } from '../shared/catalog.ts';
import { HAP_LIMITS, MAX_MIX_ONSETS_PER_BAR, MAX_PART_ONSETS_PER_BAR, findLimitViolations, queryBudget } from '../shared/limits.ts';
import { PERCUSSIVE_ROLES, PITCHED_ROLES, bpmToCps, secondsPerBar, type PartRole } from '../shared/music.ts';
import { vampLoopBars } from '../shared/schedule.ts';
import type { CheckPartInput, CheckSectionInput } from '../server/types.ts';
import { resolvedName, suggestSounds, type SoundIndex } from './catalog.ts';
import {
  chordCycleHash, clamp01, clusterScore, dbLoudness, densityScore, gainLoudness, intensityOf, lcm, mean, median, midiName,
  normalise, periodOf, pitchClass, registerOf, round, stepOf, syncopation,
} from './features.ts';
import { isQueryBudgetExceeded, withQueryBudget } from './guard.ts';
import { captureLogs, cycleState } from './query.ts';
import { resolveScales, type ScaleLookup } from './scales.ts';

export interface AnalyzeSectionInput {
  parts: (CheckPartInput & { pattern: any })[];
  bpm: number;
  scale: string | null;
  bars: number;
  vampLoopBars?: CheckSectionInput['vampLoopBars'];
  index: SoundIndex;
}

export interface PartResult {
  id: string;
  analysis: PartAnalysis;
  digest: PartDigest;
  instrument: string;
  errors: Issue[];
  warnings: Issue[];
  analyzeMs: number;
}

export interface SectionAnalysis {
  parts: PartResult[];
  mix: MixAnalysis;
  fingerprint: SectionFingerprint;
  errors: Issue[];
  warnings: Issue[];
}

/** The vamp loops at most this many bars; the checker analyses this many bars past the score. */
export const VAMP_BARS = 8;
export const MAX_ANALYSED_BARS = 72;
const RANDOM_PROBE_BARS = 8;
const RANDOM_SEED = 7919;
/** Beyond the validator's static bound; only reachable if something upstream failed. */
const HAPS_PER_QUERY_GUARD = 20_000;
/** One bar of a part, within the engine's query budget: a query that would cost more stops early. */
const queryBar = (pattern: any, bar: number, controls: Record<string, unknown>): any[] =>
  withQueryBudget(queryBudget(1), () => pattern.query(cycleState(bar, bar + 1, controls)));
const overBudget = (bar: number, e: Error, partId: string): Issue =>
  issue('density', `Playing bar ${bar} needs more work than the engine allows for one query (${e.message}).`, partId,
    'Simplify the part: fewer stacked multipliers, and no long events read at every step.');
const KEY_FIT_ERROR = 0.6;
const KEY_FIT_WARNING = 0.8;
const MIN_PITCHED_FOR_KEY_FIT = 4;
/** Reverb impulse and delay-line settings are per orbit: changing them per hap regenerates the IR
 * (superdoughoutput.mjs:69-90) or modulates the shared delay. `room` itself is only a send level. */
const CONSTANT_FX = ['roomsize', 'roomfade', 'roomlp', 'roomdim', 'ir', 'irspeed', 'irbegin', 'delaytime', 'delayfeedback', 'delaysync'];
const FX_KEYS = ['room', 'roomsize', 'delay', 'delaytime', 'delayfeedback', 'cutoff', 'hcutoff', 'bandf', 'resonance', 'lpenv', 'distort',
  'shape', 'crush', 'coarse', 'phaserdepth', 'tremolodepth', 'vib', 'detune', 'unison', 'speed', 'postgain'];
const DEFAULT_GAIN = 0.8; // superdough default (superdough.mjs:182)
const SYNTH_DEFAULT_MIDI = 36; // getFrequencyFromValue: `note || 36` (helpers.mjs:590-602)
const SAMPLE_DEFAULT_MIDI = 36; // getCommonSampleInfo: valueToMidi(hapValue, 36)
const SOUNDFONT_DEFAULT_MIDI = 48; // fontloader: note = 'c3'
/** Catalog level assumed for a sound without a measured one, so every sound's energy is on one scale. */
const PRIOR_RMS_DB = -20;

interface Onset {
  bar: number;
  pos: number;
  dur: number;
  sound: string;
  entry: CatalogSound | undefined;
  gain: number;
  /** The part's fader at the onset: its level, following the level lane. */
  level: number;
  /** Seconds of the sound's catalog level (energy over the 1 s from onset) this event plays. */
  levelSec: number;
  midi: number | null;
  bright: number;
  lowEnd: boolean;
  percussive: boolean;
  /** Numeric effect params present on this hap (for PartAnalysis.fx). */
  fx: Record<string, number> | null;
}

interface Scan {
  part: AnalyzeSectionInput['parts'][number];
  /** Onsets inside the part's window (the only ones the performer plays). */
  onsets: Onset[];
  /** Those onsets per scanned bar (density limits). */
  perBar: Map<number, number>;
  signatures: string[];
  random: boolean;
  errors: Issue[];
  warnings: Issue[];
  failed: boolean;
}

/** Bars the vamp replays: the section's `vamp.loopBars` (clamped like the performer's), else min(8, bars). */
export const analysedLoopBars = (bars: number, loopBars?: 4 | 8): number =>
  loopBars ? vampLoopBars({ bars, vamp: { allowed: true, loopBars } }) : Math.min(VAMP_BARS, bars);

/** The score bar a play bar plays: past the score, the vamp replays the last `loopBars` bars. */
export const scoreBarOf = (bar: number, bars: number, loopBars: number): number =>
  bar < bars ? bar : bars - loopBars + ((bar - bars) % loopBars);

export function analyzeSection(input: AnalyzeSectionInput, hooks: { onPart?(id: string): void } = {}): SectionAnalysis {
  const bars = Math.max(1, Math.round(input.bars));
  const analysedBars = Math.min(MAX_ANALYSED_BARS, bars + Math.min(VAMP_BARS, bars));
  const loopBars = analysedLoopBars(bars, input.vampLoopBars);
  const cps = bpmToCps(input.bpm);
  const sectionErrors: Issue[] = [];
  const sectionWarnings: Issue[] = [];
  const scales = resolveScales(input.scale, analysedBars, sectionErrors);

  const results: PartResult[] = [];
  const scans: Scan[] = [];
  for (const part of input.parts) {
    hooks.onPart?.(part.id);
    const t0 = now();
    const scan = scanPart(part, { index: input.index, cps, bars, analysedBars, loopBars });
    const result = describePart(scan, { bars, bpm: input.bpm, scales });
    results.push({ ...result, analyzeMs: round(now() - t0, 2) });
    scans.push(scan);
  }

  const mix = mixAnalysis(scans, { bars, analysedBars, bpm: input.bpm, scales, errors: sectionErrors });
  const fingerprint = fingerprintOf(scans, mix.descriptors, { bars, bpm: input.bpm, scale: input.scale });
  return { parts: results, mix, fingerprint, errors: sectionErrors, warnings: sectionWarnings };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ─── Querying ─────────────────────────────────────────────────────────────────────────────────────

interface ScanContext {
  index: SoundIndex;
  cps: number;
  bars: number;
  analysedBars: number;
  loopBars: number;
}

function scanPart(part: Scan['part'], ctx: ScanContext): Scan {
  const scan: Scan = { part, onsets: [], perBar: new Map(), signatures: [], random: false, errors: [], warnings: [], failed: false };
  const problems = new ProblemLog(part.id);
  const firstBar = Math.min(0, part.enterBar);
  const scoreBar = (bar: number) => scoreBarOf(bar, ctx.bars, ctx.loopBars);
  const activeAt = (bar: number) => {
    const b = scoreBar(bar);
    return b >= part.enterBar && (part.exitBar === null || b < part.exitBar);
  };
  // A part that starts in this section replays its score in the vamp; a continuing one runs on.
  const continues = part.continues !== false;
  const levelLanes = lanesFor(part.automation ?? [], 'level');
  const levelAt = (bar: number, pos: number) => clamp01(laneValue(levelLanes, scoreBar(bar) + pos, part.level));
  const barSec = 1 / ctx.cps;
  const controls = { _cps: ctx.cps };
  let continuous = 0;

  const { logs } = captureLogs(() => {
    for (let bar = firstBar; bar < ctx.analysedBars; bar++) {
      const pb = part.patternBarAtStart + (continues ? bar : scoreBar(bar));
      let haps: any[];
      try {
        haps = queryBar(part.pattern, pb, controls);
      } catch (e) {
        scan.errors.push(isQueryBudgetExceeded(e)
          ? overBudget(bar, e, part.id)
          : issue('runtime', `Playing bar ${bar} failed: ${(e as Error).message}`, part.id, runtimeHint((e as Error).message)));
        scan.failed = true;
        return;
      }
      if (haps.length > HAPS_PER_QUERY_GUARD) {
        scan.errors.push(issue('density', `The part produces ${haps.length} events in bar ${bar}; a part may play at most ${MAX_PART_ONSETS_PER_BAR} per bar.`, part.id));
        scan.failed = true;
        return;
      }
      const active = activeAt(bar);
      const sig: string[] = [];
      let count = 0;
      for (const hap of haps) {
        if (!hap.whole) {
          if (active) continuous++;
          continue;
        }
        if (!hap.hasOnset()) continue;
        const begin = hap.whole.begin.valueOf() as number;
        const dur = (hap.whole.end.valueOf() as number) - begin;
        sig.push(`${round(begin - pb, 4)}/${round(dur, 4)}/${stable(hap.value)}`);
        if (!active) continue; // the performer never plays it, nor reports its problems
        count++;
        const pos = begin - pb;
        const onset = readOnset(hap.value, { bar, pos, dur, level: levelAt(bar, pos), barSec }, ctx, problems);
        if (onset) scan.onsets.push(onset);
      }
      scan.perBar.set(bar, count);
      if (bar >= 0 && (continues || bar < ctx.bars)) scan.signatures.push(sig.sort().join(';'));
    }
    scan.random = !scan.failed && isRandom(scan, controls, ctx.analysedBars);
  });

  problems.flush(scan, logs);
  if (!scan.failed && scan.onsets.length === 0 && continuous > 0) {
    scan.errors.push(issue('silent', 'The part is a continuous signal with no events, so it never triggers a sound.', part.id,
      'Give it structure, e.g. .segment(8), or use the signal as a parameter: .lpf(sine.range(400, 2000)).'));
  }
  return scan;
}

/** Whether another random seed changes what the first bars play (a bar past the query budget fails the scan). */
function isRandom(scan: Scan, controls: Record<string, unknown>, analysedBars: number): boolean {
  const { part, signatures } = scan;
  const probe = Math.min(RANDOM_PROBE_BARS, analysedBars, signatures.length);
  for (let bar = 0; bar < probe; bar++) {
    const pb = part.patternBarAtStart + bar;
    let played: any[];
    try {
      played = queryBar(part.pattern, pb, { ...controls, randSeed: RANDOM_SEED });
    } catch (e) {
      if (!isQueryBudgetExceeded(e)) throw e;
      scan.errors.push(overBudget(bar, e, part.id));
      scan.failed = true;
      return false;
    }
    const haps = played
      .filter((h) => h.whole && h.hasOnset())
      .map((h) => `${round(h.whole.begin.valueOf() - pb, 4)}/${round(h.whole.end.valueOf() - h.whole.begin.valueOf(), 4)}/${stable(h.value)}`);
    if (haps.sort().join(';') !== signatures[bar]) return true;
  }
  return false;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return typeof v === 'number' ? String(round(v, 5)) : JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

const numberOr = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clampTo = (key: string, v: number) => {
  const range = HAP_LIMITS[key];
  return range ? Math.min(range.max, Math.max(range.min, v)) : v;
};

/** Collects per-hap problems once per kind, so a 72-bar scan yields one issue per problem. */
class ProblemLog {
  readonly partId: string;
  private readonly limits = new Map<string, { value: unknown; bar: number; reason: string; range: string }>();
  private readonly fx = new Map<string, Set<number>>();
  private readonly unknown = new Map<string, { s: string; bank?: string; bar: number; hint?: string }>();
  private readonly blocked = new Set<string>();
  private readonly outOfRange = new Map<string, { notes: Set<string>; bar: number; range: [number, number] }>();
  private readonly wraps = new Map<string, { n: number; count: number }>();
  private readonly missing = new Map<string, { sound: CatalogSound; n: number; variant: number; bar: number }>();
  private nonObject: { value: string; bar: number } | null = null;
  private badNote: string | null = null;
  /** Pitched sounds played with n() and no note: n → variants seen. */
  private readonly nForPitch = new Map<string, { sound: CatalogSound; ns: Set<string> }>();
  constructor(partId: string) {
    this.partId = partId;
  }

  limit(key: string, value: unknown, bar: number, reason: string, range: string): void {
    const prev = this.limits.get(key);
    const worse = typeof value === 'number' && typeof prev?.value === 'number' ? Math.abs(value) > Math.abs(prev.value) : !prev;
    if (worse) this.limits.set(key, { value, bar, reason, range });
  }
  fxValue(key: string, v: unknown): void {
    if (typeof v !== 'number' && typeof v !== 'string') return;
    const set = this.fx.get(key) ?? new Set<number>();
    set.add(typeof v === 'number' ? round(v, 6) : NaN);
    this.fx.set(key, set);
  }
  isUnknown(id: string): boolean {
    return this.unknown.has(id);
  }
  unknownSound(id: string, s: string, bank: string | undefined, bar: number, hint: string | undefined): void {
    if (!this.unknown.has(id)) this.unknown.set(id, { s, bank, bar, hint });
  }
  blockedSound(id: string): void {
    this.blocked.add(id);
  }
  soundfontRange(id: string, midi: number, bar: number, range: [number, number]): void {
    const r = this.outOfRange.get(id) ?? { notes: new Set<string>(), bar, range };
    r.notes.add(midiName(midi));
    this.outOfRange.set(id, r);
  }
  wrap(id: string, n: number, count: number): void {
    this.wraps.set(id, { n: Math.max(n, this.wraps.get(id)?.n ?? 0), count });
  }
  missingVariant(sound: CatalogSound, n: unknown, bar: number): void {
    const variant = failingVariant(sound, n);
    if (variant !== null && !this.missing.has(sound.id)) this.missing.set(sound.id, { sound, n: Number(n ?? 0), variant, bar });
  }
  nonObjectValue(value: unknown, bar: number): void {
    this.nonObject ??= { value: JSON.stringify(value)?.slice(0, 40) ?? String(value), bar };
  }
  invalidNote(message: string): void {
    this.badNote ??= message;
  }
  nWithoutNote(sound: CatalogSound, n: unknown): void {
    const seen = this.nForPitch.get(sound.id) ?? { sound, ns: new Set<string>() };
    if (seen.ns.size < 2) seen.ns.add(String(n));
    this.nForPitch.set(sound.id, seen);
  }

  /**
   * n() sets a synth's pitch only through .scale(); soundfonts and pitched samples use it to pick a
   * variant (fontloader.mjs, getCommonSampleInfo), so one fixed n is a deliberate choice of variant.
   */
  private nIgnoredForPitch(): { sound: CatalogSound } | null {
    for (const seen of this.nForPitch.values()) {
      if (seen.sound.kind === 'synth' || seen.sound.kind === 'wavetable' || seen.ns.size > 1) return seen;
    }
    return null;
  }

  flush(scan: Scan, logs: string[]): void {
    const id = this.partId;
    const err = (rule: string, message: string, hint?: string) => scan.errors.push(issue(rule, message, id, hint));
    const warn = (rule: string, message: string, hint?: string) => scan.warnings.push(issue(rule, message, id, hint, 'warning'));
    if (this.nonObject) {
      err('value', `The pattern produces plain values (${this.nonObject.value}, bar ${this.nonObject.bar}) instead of sounds.`, 'Wrap it in a control: note("c e g"), n("0 2").scale("C:minor") or s("bd sd").');
    }
    for (const [key, v] of this.limits) {
      if (v.reason === 'range') err('limit', `${key} reaches ${String(v.value)} in bar ${v.bar}; it must stay within ${v.range}.`, limitHint(key, v.range));
      else if (v.reason === 'engine-owned') err('denied', `The key "${key}" is set by the engine, not by part code.`);
      else err('limit', `The key "${key}" holds a structured value; only numbers and strings are allowed.`);
    }
    for (const [key, values] of this.fx) {
      if (values.size > 1) {
        const shown = [...values].slice(0, 4).map((x) => (Number.isNaN(x) ? '…' : String(x))).join(', ');
        err('constant-fx', `${key} changes within the part (${shown}); reverb and delay settings are shared per part and must stay constant.`,
          `Set .${key}(…) to one value; vary .room() or .delay() (the send amounts) instead.`);
      }
    }
    for (const u of this.unknown.values()) {
      err('unknown-sound', `Unknown sound "${u.bank ? `${u.s}" in bank "${u.bank}` : u.s}" (first in bar ${u.bar}).`, u.hint);
    }
    for (const sid of this.blocked) err('denied', `The sound "${sid}" is not available.`, 'Pick another sound from the catalog.');
    for (const [sid, r] of this.outOfRange) {
      err('sound-range', `${sid} can only play ${midiName(r.range[0])}–${midiName(r.range[1])}; ${[...r.notes].slice(0, 5).join(', ')} (from bar ${r.bar}) would be silent or hang.`,
        'Transpose the notes into the instrument\'s range (.transpose(12) / octave numbers) or pick another instrument.');
    }
    const nPitch = this.nIgnoredForPitch();
    for (const [sid, w] of this.wraps) {
      if (nPitch?.sound.id === sid) continue; // the n-without-scale warning explains it
      warn('sample-index', `"${sid}" has ${w.count} sample${w.count === 1 ? '' : 's'}; n=${w.n} wraps around to ${w.n % Math.max(1, w.count)}.`, `Use n values 0–${w.count - 1}.`);
    }
    for (const [sid, m] of this.missing) {
      const which = m.n === m.variant ? `variant n=${m.n}` : `n=${m.n} (variant ${m.variant} of ${m.sound.count})`;
      err('sample-index', `"${sid}" ${which} does not exist upstream, so it plays silence (first in bar ${m.bar}).`,
        `Use n values 0–${m.sound.count - 1} except ${m.sound.failingVariants!.join(', ')}.`);
    }
    if (this.badNote) err('value', this.badNote, 'Notes are names like "c3 eb3" or MIDI numbers; do arithmetic before the control: note("0 2".add(48)) or n(…).scale(…).');
    if (nPitch) {
      const { id, kind, count } = nPitch.sound;
      const message =
        kind === 'soundfont' ? `"${id}" uses n() to pick one of its ${count} variants, not the pitch, so every note plays C3.`
        : kind === 'sample' ? `"${id}" uses n() to pick a sample, not the pitch, so every note plays C2.`
        : `The synth "${id}" ignores n() for pitch, so every note plays C2.`;
      warn('n-without-scale', message, 'Use note("c3 e3") or n("0 2 4").scale("C:minor"); keep n() only to choose a variant alongside note().');
    }
    const seen = new Set<string>();
    for (const line of logs) {
      if (seen.has(line)) continue;
      seen.add(line);
      if (/Can't do arithmetic on control pattern/.test(line)) {
        err('arith-on-control', '.add()/.sub()/.mul() on a control pattern like note(…) or n(…) does nothing.',
          'Do arithmetic before the control: n("0 2".add(12)), or transpose the notes: .transpose(12).');
      } else if (/\berror\b/i.test(line)) {
        err('runtime', line.replace(/^\[\w+\]\s*(error:)?\s*/i, 'Strudel: '), runtimeHint(line));
      } else if (!/^\[bside\]/.test(line)) {
        warn('strudel', line.replace(/^\[\w+\]:?\s*/, 'Strudel: '));
      }
    }
  }
}

interface ReadContext {
  bar: number;
  pos: number;
  dur: number;
  level: number;
  barSec: number;
}

function readOnset(value: unknown, at: ReadContext, ctx: ScanContext, problems: ProblemLog): Onset | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.nonObjectValue(value, at.bar);
    return null;
  }
  const v = value as Record<string, unknown>;
  for (const violation of findLimitViolations(v)) {
    const range = violation.range ? `${violation.range.min}–${violation.range.max}` : '';
    problems.limit(violation.key, violation.value, at.bar, violation.reason, range);
  }
  for (const key of CONSTANT_FX) if (key in v) problems.fxValue(key, v[key]);

  const s = typeof v.s === 'string' ? v.s : v.s === undefined ? 'triangle' : String(v.s);
  if (s === '-' || s === '~' || s === '_') return null; // superdough skips these (superdough.mjs:533)
  const bank = typeof v.bank === 'string' ? v.bank : undefined;
  const id = resolvedName(s, bank);
  const entry = ctx.index.resolve(s, bank);
  if (BLOCKED_SOUNDS.has(id)) problems.blockedSound(id);
  else if (!entry && !problems.isUnknown(id)) problems.unknownSound(id, s, bank, at.bar, suggestSounds(ctx.index, s, bank));

  if (entry?.kind === 'sample' && typeof v.n === 'number' && entry.count > 0 && v.n >= entry.count) problems.wrap(entry.id, v.n, entry.count);
  if (entry?.failingVariants) problems.missingVariant(entry, v.n, at.bar);

  const midi = pitchOf(v, entry, problems);
  if (midi !== null && entry?.kind === 'soundfont' && entry.range && (midi < entry.range[0] || midi > entry.range[1])) {
    problems.soundfontRange(entry.id, midi, at.bar, entry.range);
  }

  const gain = clampTo('gain', numberOr(v.gain, DEFAULT_GAIN)) * clampTo('velocity', numberOr(v.velocity, 1)) * clampTo('postgain', numberOr(v.postgain, 1));
  const pitched = midi !== null;
  let bright = entry?.brightness ?? 0.5;
  if (pitched) bright += ((midi - 60) / 60) * 0.4;
  if (typeof v.cutoff === 'number') bright *= 0.25 + 0.75 * clamp01(Math.log(Math.max(v.cutoff, 1) / 80) / Math.log(20000 / 80));
  if (typeof v.hcutoff === 'number') bright += 0.25 * clamp01(Math.log(Math.max(v.hcutoff, 1) / 80) / Math.log(8000 / 80));
  if (typeof v.distort === 'number' || typeof v.shape === 'number' || typeof v.crush === 'number') bright += 0.1;
  const family = entry?.family ?? '';
  let fx: Record<string, number> | null = null;
  for (const key of FX_KEYS) if (typeof v[key] === 'number' && Number.isFinite(v[key])) (fx ??= {})[key] = v[key] as number;
  const dur = at.dur * numberOr(v.clip, 1);
  return {
    bar: at.bar,
    pos: at.pos,
    dur,
    sound: entry?.id ?? id,
    entry,
    gain,
    level: at.level,
    levelSec: levelSeconds(entry, v, Math.max(0.05, dur * at.barSec)),
    midi,
    bright: clamp01(bright),
    lowEnd: entry?.category === 'bass' || family.endsWith('/kick') || (pitched && midi < 48),
    percussive: entry?.category === 'percussion',
    fx,
  };
}

/**
 * How much of the catalog level (CatalogSound.level: RMS over the 1 s from onset) one event plays, in
 * seconds of it. superdough plays a sample to the end of its slice unless clip, loop or release is set
 * (sampler.mjs:313-316), so a hit's energy does not depend on the event's length: a sample shorter
 * than a second has all of its energy in the measured second, a longer one sounds at that level for as
 * long as it plays. Clipped samples play until the event ends. Synth drums ring out on their own
 * envelope. Synths, soundfonts and wavetables sustain for the event.
 */
function levelSeconds(entry: CatalogSound | undefined, v: Record<string, unknown>, heldSec: number): number {
  if (entry?.kind === 'sample') {
    const length = entry.durationSec ?? 1;
    const slice = length * clamp01(numberOr(v.end, 1) - numberOr(v.begin, 0));
    const whole = v.clip == null && v.loop == null && v.release == null;
    const played = whole ? slice : v.loop != null ? heldSec : Math.min(heldSec, slice);
    return played / Math.min(1, length);
  }
  if (entry?.kind === 'synth' && entry.category === 'percussion') return v.clip == null ? 1 : Math.min(1, heldSec);
  return heldSec;
}

/** MIDI pitch as superdough will play it, or null for unpitched sounds. */
function pitchOf(v: Record<string, unknown>, entry: CatalogSound | undefined, problems: ProblemLog): number | null {
  let midi: number | null = null;
  const explicit = v.freq !== undefined || v.note !== undefined;
  try {
    if (typeof v.freq === 'number') midi = core.freqToMidi(v.freq) as number;
    else if (typeof v.note === 'string') midi = core.noteToMidi(v.note) as number;
    else if (typeof v.note === 'number') midi = v.note;
    else if (v.note !== undefined) problems.invalidNote(`note has the value ${JSON.stringify(v.note)?.slice(0, 40)}, which is not a note.`);
  } catch (e) {
    problems.invalidNote(`Invalid note ${JSON.stringify(v.note)}: ${(e as Error).message}`);
  }
  if (midi !== null && !Number.isFinite(midi)) midi = null;
  const kind = entry?.kind;
  if (kind === 'synth' || kind === 'wavetable') {
    if (!entry!.pitched) return null;
    if (!midi) {
      if (v.n !== undefined && !explicit) problems.nWithoutNote(entry!, v.n);
      midi = SYNTH_DEFAULT_MIDI;
    }
    return midi + 12 * numberOr(v.octave, 0);
  }
  if (midi === null && entry?.pitched && v.n !== undefined && !explicit) problems.nWithoutNote(entry, v.n);
  if (kind === 'soundfont') return midi ?? SOUNDFONT_DEFAULT_MIDI;
  if (midi !== null) return midi;
  return entry?.pitched ? SAMPLE_DEFAULT_MIDI : null;
}

// ─── Per part ─────────────────────────────────────────────────────────────────────────────────────

interface PartContext {
  bars: number;
  bpm: number;
  scales: ScaleLookup | null;
}

/** A part's own material includes its pickup bars; the section mix covers audible events in score bars 0…bars-1. */
const isPartOnset = (o: Onset, bars: number) => o.bar < bars;
const isMixOnset = (o: Onset, bars: number) => o.bar >= 0 && o.bar < bars && o.level > 0;

function describePart(scan: Scan, ctx: PartContext): Omit<PartResult, 'analyzeMs'> {
  const { part } = scan;
  const errors = [...scan.errors];
  const warnings = [...scan.warnings];
  const firstBar = Math.min(0, part.enterBar);

  for (const [bar, count] of scan.perBar) {
    if (count > MAX_PART_ONSETS_PER_BAR) {
      errors.push(issue('density', `The part plays ${count} events in bar ${bar}; a part may play at most ${MAX_PART_ONSETS_PER_BAR} per bar.`, part.id,
        'Thin it out: fewer *n / ply / fast, or split the idea across parts.'));
      break;
    }
  }

  const activeBars: number[] = [];
  for (let b = firstBar; b < ctx.bars; b++) if (b >= part.enterBar && (part.exitBar === null || b < part.exitBar)) activeBars.push(b);
  const onsets = scan.onsets.filter((o) => isPartOnset(o, ctx.bars));
  const counts = activeBars.map((b) => onsets.filter((o) => o.bar === b).length);
  const nBars = Math.max(1, activeBars.length);
  const onsetsPerBar = onsets.length / nBars;
  const gainSum = onsets.reduce((a, o) => a + o.gain, 0);

  const sounds = soundUses(onsets);
  const pitched = onsets.filter((o) => o.midi !== null);
  const midis = pitched.map((o) => o.midi!);
  const keyFit = keyFitOf(pitched, ctx.scales);
  const pitch = midis.length
    ? {
        minMidi: round(Math.min(...midis), 2),
        maxMidi: round(Math.max(...midis), 2),
        medianMidi: round(median(midis), 2),
        distinct: new Set(midis.map(Math.round)).size,
        register: registerOf(median(midis)),
        keyFit: keyFit === null ? null : round(keyFit.fit),
      }
    : null;

  if (keyFit && !part.chromatic && !PERCUSSIVE_ROLES.has(part.role) && pitched.length >= MIN_PITCHED_FOR_KEY_FIT && keyFit.fit < KEY_FIT_WARNING) {
    const outside = keyFit.outside.slice(0, 5).map(([note, bar]) => `${note} (bar ${bar})`).join(', ');
    const message = `Only ${Math.round(keyFit.fit * 100)}% of the part's notes are in the section's scale; outside: ${outside}.`;
    const hint = 'Use n("…").scale(…) with the section scale, fix the notes, or set chromatic: true if the colour is intended.';
    if (keyFit.fit < KEY_FIT_ERROR) errors.push(issue('key-fit', message, part.id, hint));
    else warnings.push(issue('key-fit', message, part.id, hint, 'warning'));
  }

  const syncs = activeBars.map((b) => onsets.filter((o) => o.bar === b).map((o) => stepOf(o.pos))).filter((s) => s.length > 1).map(syncopation);
  const grid = new Array<number>(16).fill(0);
  for (const o of onsets) grid[stepOf(o.pos)]! += 1;
  const loudness = loudnessOf(onsets, nBars, ctx.bpm);
  const brightness = gainSum ? onsets.reduce((a, o) => a + o.bright * o.gain, 0) / gainSum : 0;
  const lowEndShare = gainSum ? onsets.filter((o) => o.lowEnd).reduce((a, o) => a + o.gain, 0) / gainSum : 0;
  const percussiveShare = gainSum ? onsets.filter((o) => o.percussive).reduce((a, o) => a + o.gain, 0) / gainSum : 0;
  const silent = onsets.length === 0 || gainSum === 0;
  const period = scan.random ? null : periodOf(scan.signatures);

  if (silent && !errors.some((e) => e.rule === 'silent' || e.rule === 'runtime')) {
    warnings.push(issue('silent', activeBars.length ? `The part makes no sound in bars ${activeBars[0]}–${activeBars[activeBars.length - 1]}.` : 'The part never plays in this section (check enterBar/exitBar).', part.id, undefined, 'warning'));
  }

  const fx: Record<string, number> = {};
  for (const o of onsets) for (const [k, v] of Object.entries(o.fx ?? {})) fx[k] = round(Math.max(fx[k] ?? -Infinity, v), 4);

  const energy = silent ? 0 : intensityOf({ density: densityScore(onsetsPerBar), loudness: loudness.score, brightness, lowEnd: lowEndShare, percussive: percussiveShare, bpm: ctx.bpm });
  const analysis: PartAnalysis = {
    id: part.id,
    role: part.role,
    onsetsPerBar: round(onsetsPerBar, 2),
    densityPerBar: { min: counts.length ? Math.min(...counts) : 0, mean: round(mean(counts), 2), max: counts.length ? Math.max(...counts) : 0 },
    sounds,
    pitch,
    syncopation: round(mean(syncs)),
    grid16: normalise(grid),
    loudness,
    brightness: round(brightness),
    lowEndShare: round(lowEndShare),
    percussiveShare: round(percussiveShare),
    random: scan.random,
    period,
    energy: round(energy),
    silent,
    fx,
  };
  const instrument = instrumentOf(sounds, onsets);
  const digest: PartDigest = {
    id: part.id,
    role: part.role,
    instrument,
    evPerBar: round(onsetsPerBar, 1),
    register: pitch?.register ?? null,
    sync: round(analysis.syncopation, 2),
    bright: round(brightness, 2),
    loud: round(loudness.score, 2),
    period: scan.random ? 'random' : period,
    keyFit: pitch?.keyFit ?? null,
  };
  return { id: part.id, analysis, digest, instrument, errors, warnings };
}

function soundUses(onsets: Onset[]): SoundUse[] {
  const shares = loudnessShares(onsets, false);
  const by = new Map<string, { entry: CatalogSound | undefined; onsets: number }>();
  for (const o of onsets) {
    const u = by.get(o.sound) ?? { entry: o.entry, onsets: 0 };
    u.onsets++;
    by.set(o.sound, u);
  }
  return [...by]
    .map(([id, u]) => ({
      id,
      kind: u.entry?.kind ?? 'sample',
      family: u.entry?.family ?? 'unknown',
      known: !!u.entry,
      onsets: u.onsets,
      share: round(shares.get(id) ?? 0),
    }))
    .sort((a, b) => b.share - a.share || b.onsets - a.onsets);
}

function instrumentOf(sounds: SoundUse[], onsets: Onset[]): string {
  const top = sounds[0];
  if (!top) return '';
  return onsets.find((o) => o.sound === top.id)?.entry?.label ?? top.id;
}

function keyFitOf(pitched: Onset[], scales: ScaleLookup | null): { fit: number; outside: [string, number][] } | null {
  if (!scales) return null;
  let inside = 0;
  let counted = 0;
  const outside: [string, number][] = [];
  for (const o of pitched) {
    if (o.bar < 0) continue;
    const pcs = scales(o.bar, o.pos);
    if (!pcs) continue;
    counted++;
    if (pcs.has(pitchClass(o.midi!))) inside++;
    else if (outside.length < 12 && !outside.some(([n]) => n === midiName(o.midi!))) outside.push([midiName(o.midi!), o.bar]);
  }
  return counted ? { fit: inside / counted, outside } : null;
}

/** A part's own loudness (at a unity fader) from measured catalog levels when every sound has one, else a gain prior. */
function loudnessOf(onsets: Onset[], nBars: number, bpm: number): PartAnalysis['loudness'] {
  const gains = onsets.map((o) => o.gain);
  const meanGain = gains.length ? mean(gains) : 0;
  const peakOverlapGain = peakOverlap(onsets.map((o) => ({ begin: o.bar + o.pos, end: o.bar + o.pos + o.dur, gain: o.gain })));
  const estRmsDb = estimateRmsDb(onsets, nBars, bpm, false);
  const score = estRmsDb !== null ? dbLoudness(estRmsDb) : gainLoudness(gains.reduce((a, b) => a + b, 0) / nBars);
  return { meanGain: round(meanGain), peakOverlapGain: round(peakOverlapGain), score: round(score), estRmsDb: estRmsDb === null ? null : round(estRmsDb, 1) };
}

/** One event's energy (catalog power × seconds of it played), at the part's fader when `faded`. */
function onsetEnergy(o: Onset, faded: boolean): number {
  const g = o.gain * (faded ? o.level : 1);
  return g * g * 10 ** ((o.entry?.level?.rmsDb ?? PRIOR_RMS_DB) / 10) * o.levelSec;
}

/** RMS over the bars: the CatalogSound.level formula, event by event. */
function estimateRmsDb(onsets: Onset[], nBars: number, bpm: number, faded: boolean): number | null {
  if (!onsets.length || onsets.some((o) => !o.entry?.level)) return null;
  const energy = onsets.reduce((a, o) => a + onsetEnergy(o, faded), 0);
  const power = energy / (nBars * secondsPerBar(bpm));
  return power > 0 ? 10 * Math.log10(power) : null;
}

/** Each sound's share of the summed RMS of all sounds: its energy, square-rooted, over the total. */
function loudnessShares(onsets: Onset[], faded: boolean): Map<string, number> {
  const energy = new Map<string, number>();
  for (const o of onsets) energy.set(o.sound, (energy.get(o.sound) ?? 0) + onsetEnergy(o, faded));
  const rms = [...energy].map(([id, e]) => [id, Math.sqrt(e)] as const);
  const total = rms.reduce((a, [, r]) => a + r, 0);
  return new Map(rms.map(([id, r]) => [id, total ? r / total : 0]));
}

function peakOverlap(spans: { begin: number; end: number; gain: number }[]): number {
  const events: [number, number][] = [];
  for (const s of spans) events.push([s.begin, s.gain], [Math.max(s.end, s.begin + 1e-6), -s.gain]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, g] of events) {
    cur += g;
    peak = Math.max(peak, cur);
  }
  return peak;
}

// ─── Mix ──────────────────────────────────────────────────────────────────────────────────────────

interface MixContext {
  bars: number;
  analysedBars: number;
  bpm: number;
  scales: ScaleLookup | null;
  errors: Issue[];
}

interface RangeDescription {
  intensity: number;
  brightness: number;
  density: number;
  D: number;
  harmonic: number;
  sync: number;
}

function mixAnalysis(scans: Scan[], ctx: MixContext): MixAnalysis {
  const live = scans.filter((s) => !s.failed);
  // Every event the performer plays counts toward the mix limit, faded out or not.
  const perBar = new Array<number>(ctx.analysedBars).fill(0);
  for (const s of live) for (const o of s.onsets) if (o.bar >= 0 && o.bar < ctx.analysedBars) perBar[o.bar]! += 1;
  const worst = perBar.reduce((best, count, bar) => (count > best.count ? { count, bar } : best), { count: 0, bar: 0 });
  if (worst.count > MAX_MIX_ONSETS_PER_BAR) {
    ctx.errors.push(issue('density', `All parts together play ${worst.count} events in bar ${worst.bar}; a section may play at most ${MAX_MIX_ONSETS_PER_BAR} per bar.`, 'mix',
      'Thin out the busiest parts or give them different entry bars.'));
  }

  const audible = live.filter((s) => s.onsets.some((o) => isMixOnset(o, ctx.bars)));
  const section = perBar.slice(0, ctx.bars);
  const describe = (from: number, to: number) => describeRange(audible, from, to, ctx);
  const edge = Math.min(4, ctx.bars);
  const start = describe(0, edge);
  const end = describe(ctx.bars - edge, ctx.bars);
  const whole = describe(0, ctx.bars);
  const rise = clamp01(4 * (end.brightness - start.brightness) + 2 * (end.D - start.D));
  const tension = (d: RangeDescription, r: number) => round(clamp01(0.4 * d.harmonic + 0.3 * d.sync + 0.3 * r));
  const tStart = tension(start, 0);
  const tEnd = tension(end, rise);

  const allSection = audible.flatMap((s) => s.onsets.filter((o) => isMixOnset(o, ctx.bars)).map((o) => ({ begin: o.bar + o.pos, end: o.bar + o.pos + o.dur, gain: o.gain * o.level })));
  const periods = audible.map((s) => (s.random ? null : periodOf(s.signatures)));
  const period = periods.length && periods.every((p): p is number => p !== null) ? periods.reduce((a, b) => lcm(a, b), 1) : null;

  return {
    descriptors: { intensity: round(whole.intensity), brightness: round(whole.brightness), density: round(whole.density), tension: round((tStart + tEnd) / 2) },
    spans: {
      intensity: { start: round(start.intensity), end: round(end.intensity) },
      brightness: { start: round(start.brightness), end: round(end.brightness) },
      density: { start: round(start.density), end: round(end.density) },
      tension: { start: tStart, end: tEnd },
    },
    onsetsPerBar: round(mean(section), 2),
    maxOnsetsPerBar: Math.max(0, ...section),
    peakOverlapGain: round(peakOverlap(allSection)),
    audibleParts: audible.length,
    period: period !== null && period <= ctx.bars ? period : null,
  };
}

/** Descriptors of what sounds in bars [from, to): each event weighted by its gain at the part's fader. */
function describeRange(scans: Scan[], from: number, to: number, ctx: MixContext): RangeDescription {
  const nBars = Math.max(1, to - from);
  const inRange = (o: Onset) => o.bar >= from && o.bar < to && o.level > 0;
  const parts = scans.map((s) => ({ scan: s, onsets: s.onsets.filter(inRange) })).filter((p) => p.onsets.length > 0);
  const weighted = parts.flatMap((p) => p.onsets.map((o) => ({ o, w: o.gain * o.level })));
  const wSum = weighted.reduce((a, x) => a + x.w, 0);
  const share = (pred: (o: Onset) => boolean) => (wSum ? weighted.filter((x) => pred(x.o)).reduce((a, x) => a + x.w, 0) / wSum : 0);
  const count = weighted.length;
  const D = densityScore(count / nBars);
  const brightness = wSum ? weighted.reduce((a, x) => a + x.o.bright * x.w, 0) / wSum : 0;

  const measured = parts.every((p) => p.onsets.every((o) => o.entry?.level));
  let loudness: number;
  if (measured && parts.length) {
    const power = parts.reduce((a, p) => {
      const db = estimateRmsDb(p.onsets, nBars, ctx.bpm, true);
      return a + (db === null ? 0 : 10 ** (db / 10));
    }, 0);
    loudness = power > 0 ? dbLoudness(10 * Math.log10(power)) : 0;
  } else {
    loudness = gainLoudness(wSum / nBars);
  }
  const intensity = count ? intensityOf({ density: D, loudness, brightness, lowEnd: share((o) => o.lowEnd), percussive: share((o) => o.percussive), bpm: ctx.bpm }) : 0;

  const pitchedRegisters = parts
    .filter((p) => PITCHED_ROLES.has(p.scan.part.role as PartRole))
    .map((p) => p.onsets.filter((o) => o.midi !== null).map((o) => o.midi!))
    .filter((m) => m.length)
    .map((m) => registerOf(median(m)));
  const clash = new Set(pitchedRegisters).size < pitchedRegisters.length ? 0.1 : 0;
  const density = clamp01(0.5 * clamp01(parts.length / 6) + 0.5 * D + clash);

  const pitched = parts.flatMap((p) => (p.scan.part.chromatic ? [] : p.onsets.filter((o) => o.midi !== null)));
  const fit = keyFitOf(pitched, ctx.scales);
  const clusters: number[] = [];
  for (let b = from; b < to; b++) {
    const c = clusterScore(parts.flatMap((p) => p.onsets.filter((o) => o.bar === b && o.midi !== null).map((o) => pitchClass(o.midi!))));
    if (c !== null) clusters.push(c);
  }
  const harmonic = clamp01(0.6 * (fit ? 1 - fit.fit : 0) + 0.4 * mean(clusters));

  const syncWeights = parts.map((p) => {
    const perBar: number[] = [];
    for (let b = from; b < to; b++) {
      const steps = p.onsets.filter((o) => o.bar === b).map((o) => stepOf(o.pos));
      if (steps.length > 1) perBar.push(syncopation(steps));
    }
    return { sync: mean(perBar), w: p.onsets.reduce((a, o) => a + o.gain * o.level, 0) };
  });
  const syncW = syncWeights.reduce((a, x) => a + x.w, 0);
  const sync = syncW ? syncWeights.reduce((a, x) => a + x.sync * x.w, 0) / syncW : 0;
  return { intensity, brightness, density, D, harmonic, sync };
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────────────────────────

const HARMONIC_ROLES: ReadonlySet<string> = new Set(['bass', 'chords', 'pad', 'arp']);

function fingerprintOf(scans: Scan[], descriptors: MixAnalysis['descriptors'], ctx: { bars: number; bpm: number; scale: string | null }): SectionFingerprint {
  const kick = new Array<number>(16).fill(0);
  const backbeat = new Array<number>(16).fill(0);
  const harmony: number[][] = Array.from({ length: ctx.bars }, () => []);
  const sounding: Onset[] = [];
  for (const s of scans) {
    if (s.failed) continue;
    for (const o of s.onsets) {
      if (!isMixOnset(o, ctx.bars)) continue;
      sounding.push(o);
      const w = o.gain * o.level;
      const family = o.entry?.family ?? '';
      if (family.endsWith('/kick') || (s.part.role === 'kick' && o.percussive)) kick[stepOf(o.pos)]! += w;
      if (/\/(snare|clap|rim)$/.test(family) || (s.part.role === 'snare' && o.percussive)) backbeat[stepOf(o.pos)]! += w;
      if (HARMONIC_ROLES.has(s.part.role) && o.midi !== null) harmony[o.bar]!.push(pitchClass(o.midi));
    }
  }
  const shares: Record<string, number> = {};
  for (const [id, share] of loudnessShares(sounding, true)) shares[id] = round(share);
  return {
    descriptors,
    soundShares: shares,
    kickGrid16: normalise(kick),
    backbeatGrid16: normalise(backbeat),
    scale: ctx.scale ?? '',
    bpm: ctx.bpm,
    chordHash: chordCycleHash(harmony),
  };
}

// ─── Issues ───────────────────────────────────────────────────────────────────────────────────────

function issue(rule: string, message: string, path: string, hint?: string, severity: Issue['severity'] = 'error'): Issue {
  return hint ? { severity, rule, message, path, hint } : { severity, rule, message, path };
}

function limitHint(key: string, range: string): string {
  if (key === 'pan') return 'jux()/juxBy() add ±0.5 to pan; keep .pan() within 0.25–0.75 when combined with them.';
  return `Keep ${key} inside ${range}; the engine clamps it for listeners.`;
}

export interface Probe {
  /** Hap-value limit violations, the first per key. */
  violations: { key: string; value: unknown; range: string }[];
  /** The busiest bar (0 = `fromBar`) and its onsets; a bar past the query guard stops the probe. */
  densest: { bar: number; onsets: number };
  /** The bar (0 = `fromBar`) whose query ran out of the engine's query budget, which stops the probe. */
  overBudget?: number;
}

/** Limits and density over the first `bars` bars of a pattern (for knob extremes), one bar per query. */
export function probeBars(pattern: any, fromBar: number, bars: number, bpm: number): Probe {
  const out = new Map<string, { key: string; value: unknown; range: string }>();
  const densest = { bar: 0, onsets: 0 };
  for (let bar = 0; bar < bars; bar++) {
    let haps: any[];
    try {
      haps = queryBar(pattern, fromBar + bar, { _cps: bpmToCps(bpm) });
    } catch (e) {
      if (!isQueryBudgetExceeded(e)) throw e;
      return { violations: [...out.values()], densest, overBudget: bar };
    }
    if (haps.length > HAPS_PER_QUERY_GUARD) return { violations: [...out.values()], densest: { bar, onsets: haps.length } };
    let onsets = 0;
    for (const hap of haps) {
      if (!hap.whole || !hap.hasOnset()) continue;
      onsets++;
      if (!hap.value || typeof hap.value !== 'object') continue;
      for (const v of findLimitViolations(hap.value)) {
        if (v.reason === 'range' && v.range && !out.has(v.key)) out.set(v.key, { key: v.key, value: v.value, range: `${v.range.min}–${v.range.max}` });
      }
    }
    if (onsets > densest.onsets) Object.assign(densest, { bar, onsets });
  }
  return { violations: [...out.values()], densest };
}

function runtimeHint(message: string): string | undefined {
  if (/Scale name .* is incomplete/.test(message)) return 'Write scales as tonic:mode, e.g. .scale("C:minor").';
  if (/is not a function/.test(message)) return 'Check that every method follows a pattern and that functions are written like x => x.fast(2).';
  if (/voicing|chord/i.test(message)) return 'Spell chords the Strudel way: "C^7 Dm7 G7 Am9" (^ for major seventh).';
  return undefined;
}
