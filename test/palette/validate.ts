// A strict structural validator for Catalog (src/shared/catalog.ts), independent of the app's own
// parser, so the generated file and the fixture are checked against the contract itself.
import { SOUND_CATEGORIES } from '../../src/shared/catalog.ts';

const KINDS = ['synth', 'sample', 'soundfont', 'wavetable'];
const MAP_KINDS = ['samples', 'bank-aliases'];
const SOUND_KEYS = new Set(['id', 'kind', 'category', 'family', 'tags', 'label', 'count', 'pitched', 'source', 'machine', 'usage', 'range', 'brightness', 'level', 'bytes', 'durationSec', 'aliases', 'license']);
const MAP_KEYS = new Set(['id', 'kind', 'path', 'upstream', 'license', 'order']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Returns every problem found (empty when `json` is a valid Catalog). */
export function catalogProblems(json: unknown): string[] {
  const problems: string[] = [];
  const bad = (where: string, what: string): void => {
    problems.push(`${where}: ${what}`);
  };
  if (!isObj(json)) return ['catalog: not an object'];
  for (const key of ['version', 'generatedAt', 'soundfontBase']) if (!isStr(json[key])) bad('catalog', `${key} must be a non-empty string`);
  if (isStr(json.generatedAt) && Number.isNaN(Date.parse(json.generatedAt))) bad('catalog', 'generatedAt is not a date');
  if (!Array.isArray(json.maps)) bad('catalog', 'maps must be an array');
  if (!Array.isArray(json.sounds)) bad('catalog', 'sounds must be an array');
  if (problems.length) return problems;

  (json.maps as unknown[]).forEach((map, i) => {
    const where = `maps[${i}]`;
    if (!isObj(map)) return bad(where, 'not an object');
    for (const key of Object.keys(map)) if (!MAP_KEYS.has(key)) bad(where, `unknown key ${key}`);
    for (const key of ['id', 'path', 'upstream', 'license']) if (!isStr(map[key])) bad(where, `${key} must be a non-empty string`);
    if (!MAP_KINDS.includes(map.kind as string)) bad(where, `kind ${String(map.kind)}`);
    if (!Number.isInteger(map.order)) bad(where, 'order must be an integer');
  });

  (json.sounds as unknown[]).forEach((sound, i) => {
    const where = `sounds[${i}]${isObj(sound) && isStr(sound.id) ? ` (${sound.id})` : ''}`;
    if (!isObj(sound)) return bad(where, 'not an object');
    for (const key of Object.keys(sound)) if (!SOUND_KEYS.has(key)) bad(where, `unknown key ${key}`);
    for (const key of ['id', 'family', 'tags', 'label', 'source', 'license']) if (!isStr(sound[key])) bad(where, `${key} must be a non-empty string`);
    if (isStr(sound.id) && sound.id !== sound.id.toLowerCase()) bad(where, 'id must be lower-case');
    if (!KINDS.includes(sound.kind as string)) bad(where, `kind ${String(sound.kind)}`);
    if (!(SOUND_CATEGORIES as readonly unknown[]).includes(sound.category)) bad(where, `category ${String(sound.category)}`);
    if (isStr(sound.family) && !/^[a-z-]+\/[a-z-]+$/.test(sound.family)) bad(where, `family ${sound.family} is not <group>/<detail>`);
    if (!Number.isInteger(sound.count) || (sound.count as number) < 1) bad(where, 'count must be a positive integer');
    if (typeof sound.pitched !== 'boolean') bad(where, 'pitched must be a boolean');
    if (sound.machine !== undefined && !isStr(sound.machine)) bad(where, 'machine must be a string');
    if (!isObj(sound.usage) || !isStr(sound.usage.s)) bad(where, 'usage.s must be a string');
    else {
      for (const key of Object.keys(sound.usage)) if (key !== 's' && key !== 'bank') bad(where, `unknown usage key ${key}`);
      if (sound.usage.bank !== undefined && !isStr(sound.usage.bank)) bad(where, 'usage.bank must be a string');
    }
    if (sound.range !== undefined) {
      const r = sound.range;
      if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n) && n >= 0 && n <= 127) || (r[0] as number) > (r[1] as number))
        bad(where, 'range must be [lo, hi] MIDI notes');
    }
    if (!isNum(sound.brightness) || sound.brightness < 0 || sound.brightness > 1) bad(where, 'brightness must be in 0..1');
    if (sound.level !== null) {
      const level = sound.level;
      if (!isObj(level) || !isNum(level.rmsDb) || !isNum(level.peakDb) || !isNum(level.centroidHz) || Object.keys(level).length !== 3)
        bad(where, 'level must be null or { rmsDb, peakDb, centroidHz }');
      else if (level.rmsDb > level.peakDb) bad(where, 'level.rmsDb above peakDb');
    }
    if (sound.bytes !== undefined && (!Number.isInteger(sound.bytes) || (sound.bytes as number) <= 0)) bad(where, 'bytes must be a positive integer');
    if (sound.durationSec !== undefined && (!isNum(sound.durationSec) || sound.durationSec <= 0)) bad(where, 'durationSec must be positive');
    if (sound.aliases !== undefined && (!Array.isArray(sound.aliases) || !sound.aliases.every(isStr))) bad(where, 'aliases must be strings');
  });
  return problems;
}
