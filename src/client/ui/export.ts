// "Copy" and "Open in strudel.cc": the playing section as a standalone Strudel program. The room's
// own extensions are resolved for strudel.cc: knob("x") becomes the value the knob has right now,
// faders become .postgain() at their current level, the tempo becomes setcpm, and sample maps
// strudel.cc doesn't preload get samples().
import { code2hash } from '@strudel/core';
import type { Catalog, CatalogMap } from '../../shared/catalog.ts';
import type { Knob } from '../../shared/plan.ts';
import type { SectionProgram } from '../../shared/program.ts';
import { createSoundIndex } from '../../strudel/catalog.ts';
import type { Engine } from '../engine/types.ts';

export const STRUDEL_URL = 'https://strudel.cc/';

/** Maps strudel.cc registers by itself (website/src/repl/prebake.mjs), plus our built-in synths. */
const PREBAKED_MAPS: ReadonlySet<string> = new Set(['builtin', 'soundfonts', 'tidal-drum-machines', 'tidal-drum-machines-alias', 'vcsl', 'salamander-piano', 'mridangam']);

export interface ExportPart {
  id: string;
  code: string;
  /** The fader as it sounds now. */
  level: number;
  knobs: readonly Knob[];
  /** Knob values as they sound now; a knob missing here gets its declared default. */
  knobValues?: Readonly<Record<string, number>>;
}

export interface ExportInput {
  title: string;
  side: string;
  track: number;
  author: SectionProgram['author'];
  bpm: number;
  parts: readonly ExportPart[];
  /** Maps the section's sounds come from (see `mapsForSounds`). */
  maps: readonly CatalogMap[];
  sourceUrl: string;
}

const CUT_BY: Record<SectionProgram['author'], string> = { claude: 'Claude', external: 'a guest composer', scripted: 'the autopilot' };

const oneLine = (s: string): string => s.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

function num(v: number): string {
  return String(Math.round(v * 10_000) / 10_000);
}

/** knob("x") → a number (strudel.cc has no room knobs): `values[x]`, else the knob's declared default. */
export function bakeKnobs(code: string, knobs: readonly Knob[], values: Readonly<Record<string, number>> = {}): string {
  return code.replace(/\bknob\(\s*(["'`])([a-z][a-z0-9_]{0,15})\1\s*\)/g, (match, _q: string, name: string) => {
    const k = knobs.find((x) => x.name === name);
    return k ? num(values[name] ?? k.default) : match;
  });
}

/** A section's parts with the knob values and faders the engine plays at `cycle` (the declared ones if it doesn't know the section). */
export function soundingParts(engine: Pick<Engine, 'sections' | 'knobValues' | 'levelAt'>, section: SectionProgram, cycle: number): ExportPart[] {
  const known = engine.sections().some((s) => s.id === section.id);
  return section.parts.map((p) => {
    const declared: ExportPart = { id: p.id, code: p.code, level: p.level, knobs: p.knobs };
    if (!known) return declared;
    const instance = `${section.id}:${p.id}`;
    return { ...declared, level: engine.levelAt(instance, cycle), knobValues: engine.knobValues(instance, cycle) };
  });
}

/** The catalog maps the given sounds (VisualEvent.sound: bank applied, lower-case) come from. */
export function mapsForSounds(catalog: Catalog, sounds: Iterable<string>): CatalogMap[] {
  const index = createSoundIndex(catalog);
  const sources = new Set<string>();
  for (const s of sounds) {
    const hit = index.get(s);
    if (hit) sources.add(hit.source);
  }
  return catalog.maps.filter((m) => sources.has(m.id));
}

/** `samples()` lines for maps strudel.cc doesn't preload, pinned to the vendored commit. */
export function sampleLines(maps: readonly CatalogMap[]): string[] {
  const out: string[] = [];
  for (const m of [...maps].sort((a, b) => a.order - b.order)) {
    if (PREBAKED_MAPS.has(m.id) || m.kind !== 'samples') continue;
    const match = /^([\w.-]+)\/([\w.-]+)@([0-9a-f]{7,40})$/i.exec(m.upstream);
    if (!match) continue;
    const line = `samples('github:${match[1]}/${match[2]}/${match[3]}')`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

export function strudelProgram(input: ExportInput): string {
  const lines = [
    `// "${oneLine(input.title)}" — Side ${oneLine(input.side)}, track ${input.track}, cut live by ${CUT_BY[input.author]} in B-Side`,
    `// ${oneLine(input.sourceUrl)}`,
    `setcpm(${num(input.bpm)}/4)`,
    ...sampleLines(input.maps),
    '',
  ];
  for (const p of input.parts) {
    const code = bakeKnobs(p.code, p.knobs, p.knobValues).trimEnd();
    const level = Math.round(p.level * 100) / 100;
    lines.push(`${p.id}: ${code}${level < 1 ? `\n  .postgain(${num(level)})` : ''}`, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function strudelUrl(program: string): string {
  return `${STRUDEL_URL}#${code2hash(program)}`;
}
