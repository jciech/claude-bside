// Plain-text rules for anything a listener or a composer writes that other people will read:
// request text, liner notes, section names, fork labels, request replies, movement blurbs.
// These strings are DATA. The UI renders them with Svelte's escaped `{text}` or `textContent` —
// never `{@html}` / `innerHTML` (a test greps the client for it).

// Control characters, soft hyphens, zero-width and invisible operators, bidi marks and overrides,
// the BOM and tag characters (built from ASCII escapes on purpose).
const CONTROL = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}]',
  'gu',
);
const ANGLE = /[<>]/g;
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ai|gg|xyz|app|dev|ly|me|co)\b\S*/gi;
const MARKUP = /(?:\[[^\]]*\]\([^)]*\)|`{3}|<\/?[a-z][^>]*>|&[a-z]+;|javascript:)/i;

/** Normalise untrusted text for storage and display: strip control/bidi chars and angle brackets, collapse whitespace, cut to `max`. */
export function sanitizePlainText(input: string, max: number): string {
  return input
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(ANGLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const MAX_REQUEST_CHARS = 140;
const hasUrl = (text: string) => new RegExp(URLISH.source, 'i').test(text);

/**
 * Listener request text: plain text with URLs removed. URLs are found in the cleaned text, so an
 * invisible character or an angle bracket can't hide one until cleaning joins it back up, and in its
 * NFKC form, so a lookalike (a fullwidth dot, letters) can't either. Only text that hides a URL is
 * kept in that folded form; anything else keeps what was typed (Korean jamo, x²).
 */
export function sanitizeRequestText(input: string): string {
  const typed = sanitizePlainText(input, MAX_REQUEST_CHARS);
  if (!hasUrl(typed) && !hasUrl(sanitizePlainText(typed.normalize('NFKC'), Infinity))) return typed;
  let text = sanitizePlainText(input.normalize('NFKC'), Infinity);
  // Until nothing changes: removing one URL, or the cut to length, can join or end another.
  for (let before = ''; before !== text; ) {
    before = text;
    text = sanitizePlainText(text.replace(URLISH, ''), MAX_REQUEST_CHARS);
  }
  return text;
}

/** True when composer-authored public text is acceptable as-is (no URLs, markup or control chars). */
export function isPublicText(input: string): boolean {
  const has = (re: RegExp) => new RegExp(re.source, re.flags.replace('g', '')).test(input);
  return !has(CONTROL) && !has(ANGLE) && !has(URLISH) && !MARKUP.test(input);
}

/** Normalised key used to merge identical requests ("More jazz pls!" ≈ "jazz"). */
export function requestMergeKey(text: string): string {
  const STOP = new Set(['please', 'pls', 'plz', 'more', 'some', 'can', 'we', 'you', 'a', 'an', 'the', 'bit', 'little', 'get', 'have', 'add', 'maybe', 'could', 'would', 'lets', "let's", 'i', 'want']);
  return sanitizePlainText(text, 140)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .sort()
    .join(' ');
}
