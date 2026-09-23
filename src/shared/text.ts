// Plain-text rules for anything a listener or a composer writes that other people will read:
// request text, liner notes, section names, fork labels, request replies, movement blurbs.
// These strings are DATA. The UI renders them with Svelte's escaped `{text}` or `textContent` —
// never `{@html}` / `innerHTML` (a test greps the client for it).

// Control characters, zero-width and bidi overrides (built from ASCII escapes on purpose).
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069]', 'g');
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

/** Listener request text: plain text with URLs removed. */
export function sanitizeRequestText(input: string): string {
  return sanitizePlainText(input.replace(URLISH, ''), 140);
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
