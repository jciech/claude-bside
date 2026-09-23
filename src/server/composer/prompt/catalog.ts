// The catalog as the composer reads it: every sound grouped by category and family, compact enough to
// live in the cached system prompt. Drum machines collapse to one line per machine.
import { SOUND_CATEGORIES, type Catalog, type CatalogSound } from '../../../shared/catalog.ts';
import { BLOCKED_SOUNDS } from '../../../shared/catalog.ts';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** The first `n` comma-separated descriptors, minus words the id already says. */
function shortTags(s: CatalogSound, n: number, skip: readonly string[] = []): string {
  const words = s.tags.split(',').map((t) => t.trim()).filter((t) => t && !skip.includes(t) && !s.id.includes(t.replace(/\s+/g, '_')));
  return words.slice(0, n).join(', ');
}

function soundEntry(s: CatalogSound): string {
  const silent = s.failingVariants?.length ? `; n=${s.failingVariants.join(',')} silent` : '';
  const count = s.count > 1 ? `(${s.count}${silent})` : '';
  const range = s.kind === 'soundfont' && s.range && (s.range[0] > 21 || s.range[1] < 108) ? `[${noteName(s.range[0])}–${noteName(s.range[1])}]` : '';
  const tags = shortTags(s, 2);
  return `${s.id}${count}${range}${tags ? ` ${tags}` : ''}`;
}

function machineLine(machine: string, sounds: CatalogSound[]): string {
  const kit = sounds
    .map((s) => ({ s: s.usage.s, count: s.count }))
    .sort((a, b) => a.s.localeCompare(b.s))
    .map((i) => `${i.s}${i.count > 1 ? i.count : ''}`)
    .join(' ');
  const alias = sounds[0]!.aliases?.[0]?.split('_')[0];
  const instruments = new Set(sounds.map((s) => s.tags.split(',')[0]!.trim()));
  const counts = new Map<string, number>();
  for (const s of sounds) for (const t of s.tags.split(',').slice(1)) counts.set(t.trim(), (counts.get(t.trim()) ?? 0) + 1);
  const character = [...counts.entries()]
    .filter(([t, c]) => t && !instruments.has(t) && c >= Math.min(2, sounds.length))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  return `${machine}${alias ? ` (${alias})` : ''}${character.length ? ` ${character.join(', ')}` : ''}: ${kit}`;
}

export function renderCatalog(catalog: Catalog): string {
  const usable = catalog.sounds.filter((s) => !BLOCKED_SOUNDS.has(s.id));
  const machines = new Map<string, CatalogSound[]>();
  const rest: CatalogSound[] = [];
  for (const s of usable) {
    if (s.machine && s.usage.bank) machines.set(s.usage.bank, [...(machines.get(s.usage.bank) ?? []), s]);
    else rest.push(s);
  }
  const lines: string[] = [
    '# The catalog',
    '',
    'Every sound the room can play. `id(n)`: n variants (sample index `s("id:3")`/`.n(3)`, or soundfont variant `.n(k)`);',
    '`[A1–C6]`: a soundfont\'s playable range (notes outside it are silent). Pitched sources take `note()`/`n().scale()`.',
    '`id(12; n=11 silent)`: variant 11 does not exist and plays nothing; the checker rejects it.',
    '',
    '## Drum machines: s("bd sd hh").bank("Machine") — machine (alias) character: instruments with counts',
    ...[...machines.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([m, sounds]) => machineLine(m, sounds)),
  ];
  for (const category of SOUND_CATEGORIES) {
    const inCategory = rest.filter((s) => s.category === category);
    if (!inCategory.length) continue;
    lines.push('', `## ${category}`);
    const families = new Map<string, CatalogSound[]>();
    for (const s of inCategory) families.set(s.family, [...(families.get(s.family) ?? []), s]);
    for (const [family, sounds] of [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const compact = family.startsWith('wavetable/') && sounds.length > 8;
      const entries = sounds.sort((a, b) => a.id.localeCompare(b.id)).map((s) => (compact ? `${s.id}${shortTags(s, 1) ? ` ${shortTags(s, 1)}` : ''}` : soundEntry(s)));
      lines.push(`- ${family}: ${entries.join('; ')}`);
    }
  }
  return lines.join('\n');
}
