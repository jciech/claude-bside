// The code view's model: a part's `id: code` cut into spans at every token, mini-notation atom and
// fresh-ink boundary, so highlighting is a class toggle on the spans of the atoms that are sounding
// (visual-design research §3.3; strudel.cc re-decorates CodeMirror every frame instead). Atom
// offsets come from the same transpiler call the engine compiles with, so they match hap locations.
import { parse, tokenizer, type Node } from 'acorn';
import { transpiler } from '@strudel/transpiler';
import type { Range } from './ink.ts';

export type SegmentClass = 'label' | 'str' | 'num' | 'fn' | 'punct' | 'ws';

export interface Segment {
  text: string;
  cls: SegmentClass;
  /** `${start}:${end}` of the mini-notation atom this piece belongs to (code offsets, no label). */
  atom: string | null;
  /** Atoms of the strings that carry the music (sounds, notes, rhythms) light fully; others underline. */
  primary: boolean;
  fresh: boolean;
}

/** Calls whose first mini-notation argument is the music itself. */
const PRIMARY_CALLS = new Set(['s', 'sound', 'note', 'n', 'struct', 'mask', 'chord', 'arp', 'beat']);

const atomKey = (r: Range): string => `${r.start}:${r.end}`;

export function atomLocations(code: string): Range[] {
  try {
    const t = transpiler(code, { wrapAsync: false, addReturn: true, emitMiniLocations: true, emitWidgets: false }) as { miniLocations: [number, number][] };
    return t.miniLocations.map(([start, end]) => ({ start, end }));
  } catch {
    return [];
  }
}

function primaryRanges(code: string): Range[] {
  const out: Range[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Node & Record<string, unknown>;
    if (typeof n.type !== 'string') return;
    if (n.type === 'CallExpression') {
      const callee = n.callee as { type: string; name?: string; property?: { name?: string } };
      const name = callee.type === 'Identifier' ? callee.name : callee.property?.name;
      const first = (n.arguments as Node[])[0];
      if (name && PRIMARY_CALLS.has(name) && first && (first.type === 'Literal' || first.type === 'TemplateLiteral')) {
        out.push({ start: first.start, end: first.end });
      }
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') visit(v);
    }
  };
  try {
    visit(parse(code, { ecmaVersion: 2022 }));
  } catch {
    // Unparseable code still displays; nothing lights fully.
  }
  return out;
}

function tokens(code: string): { start: number; end: number; cls: SegmentClass }[] {
  const out: { start: number; end: number; cls: SegmentClass }[] = [];
  try {
    for (const t of tokenizer(code, { ecmaVersion: 2022 })) {
      const label = t.type.label;
      const cls: SegmentClass = label === 'string' || label === 'template' || label === '`' ? 'str' : label === 'num' ? 'num' : label === 'name' ? 'fn' : 'punct';
      out.push({ start: t.start, end: t.end, cls });
    }
  } catch {
    return [{ start: 0, end: code.length, cls: 'punct' }];
  }
  return out;
}

/**
 * Cuts `${id}: ${code}` into display segments. `atoms` are the part's mini-notation locations;
 * `fresh` are ranges of `code` inked as new.
 */
export function segmentPart(id: string, code: string, atoms: readonly Range[], fresh: readonly Range[]): Segment[] {
  const prefix = `${id}: `;
  const text = prefix + code;
  const P = prefix.length;
  const toks = tokens(code);
  const primary = primaryRanges(code);
  const cuts = new Set<number>([0, P, text.length]);
  for (const t of toks) cuts.add(t.start + P).add(t.end + P);
  for (const a of atoms) cuts.add(a.start + P).add(a.end + P);
  for (const f of fresh) cuts.add(f.start + P).add(f.end + P);
  const points = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((a, b) => a - b);

  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    const piece = text.slice(a, b);
    if (b <= P) {
      out.push({ text: piece, cls: 'label', atom: null, primary: false, fresh: false });
      continue;
    }
    const ca = a - P;
    const cb = b - P;
    const tok = toks.find((t) => t.start <= ca && t.end >= cb);
    const atom = atoms.find((r) => r.start <= ca && r.end >= cb) ?? null;
    out.push({
      text: piece,
      cls: tok ? tok.cls : 'ws',
      atom: atom ? atomKey(atom) : null,
      primary: atom !== null && primary.some((r) => r.start <= atom.start && r.end >= atom.end),
      fresh: fresh.some((r) => r.start <= ca && r.end >= cb),
    });
  }
  return mergeSegments(out);
}

/** Joins neighbours that render identically (fewer spans to toggle and lay out). */
function mergeSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.atom === null && s.atom === null && last.cls === s.cls && last.fresh === s.fresh) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}
