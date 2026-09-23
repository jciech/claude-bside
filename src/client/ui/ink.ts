// Fresh ink: which characters of a part's new code differ from the previous instance's code
// (docs/DESIGN.md "Code changes"). A token-level LCS keeps the marks readable: `hpf(7000)` →
// `hpf(8000)` inks `8000`, `"white*8"` → `"white*16"` inks `16`, not scattered single characters.

export interface Range {
  start: number;
  end: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

const TOKEN = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\s+|[^\sA-Za-z_$\d]/g;
/** Beyond this many token pairs the diff is skipped and the whole row is inked (codes are ≤ 1200 chars). */
const MAX_CELLS = 400_000;

function tokenize(code: string): Token[] {
  const out: Token[] = [];
  for (const m of code.matchAll(TOKEN)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

const isSpace = (t: Token): boolean => /^\s+$/.test(t.text);

function whole(code: string): Range[] {
  const start = code.length - code.trimStart().length;
  const end = code.trimEnd().length;
  return end > start ? [{ start, end }] : [];
}

/** Ranges of `next` that are new relative to `prev` (null prev = a new part: everything is fresh). */
export function freshInk(prev: string | null, next: string): Range[] {
  if (prev === null) return whole(next);
  if (prev === next) return [];
  const a = tokenize(prev);
  const b = tokenize(next);
  if (a.length * b.length > MAX_CELLS) return whole(next);
  // lcs[i][j] = LCS length of a[i..] and b[j..], row-major in one typed array.
  const w = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i]!.text === b[j]!.text ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const fresh = new Array<boolean>(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i]!.text === b[j]!.text) {
      i++;
      j++;
    } else if (i < a.length && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      i++;
    } else {
      fresh[j] = true;
      j++;
    }
  }
  const out: Range[] = [];
  for (let k = 0; k < b.length; k++) {
    const t = b[k]!;
    if (!fresh[k] || isSpace(t)) continue;
    const last = out[out.length - 1];
    // Join marks separated only by whitespace that is itself new or trivially small.
    const between = last ? next.slice(last.end, t.start) : '';
    if (last && (last.end === t.start || (/^\s*$/.test(between) && !between.includes('\n')))) last.end = t.end;
    else out.push({ start: t.start, end: t.end });
  }
  return out;
}
