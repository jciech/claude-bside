// How the autopilot reads listener requests: as data, matched against its own ensembles' tags and a
// few mood words. It never follows instructions in them and never repeats their text; every reply
// is built from the library's own vocabulary, and says only what the plan does.
import type { CrowdSummary } from '../../shared/composer-api.ts';
import type { RequestDecision } from '../../shared/plan.ts';
import { isPublicText } from '../../shared/text.ts';
import type { Ensemble } from './library/index.ts';

/** A position or a direction in pad space. */
export interface Mood {
  intensity: number;
  brightness: number;
}

export interface Wish {
  requestId: string;
  support: number;
  ensemble: Ensemble | null;
  /** Mood leaning in pad space, each -1..1 (0 when the text names none). */
  lean: Mood;
}

const MOOD_WORDS: Record<string, { intensity?: number; brightness?: number }> = {
  darker: { brightness: -1 },
  dark: { brightness: -1 },
  moody: { brightness: -1 },
  deeper: { brightness: -1 },
  brighter: { brightness: 1 },
  bright: { brightness: 1 },
  happy: { brightness: 1 },
  happier: { brightness: 1 },
  uplifting: { brightness: 1, intensity: 0.5 },
  calm: { intensity: -1 },
  calmer: { intensity: -1 },
  chill: { intensity: -1 },
  chiller: { intensity: -1 },
  slower: { intensity: -1 },
  softer: { intensity: -1 },
  quieter: { intensity: -1 },
  relax: { intensity: -1 },
  harder: { intensity: 1 },
  faster: { intensity: 1 },
  louder: { intensity: 1 },
  energy: { intensity: 1 },
  intense: { intensity: 1 },
  heavier: { intensity: 1 },
  banger: { intensity: 1 },
  dance: { intensity: 0.5 },
};

const normalise = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** The ensemble whose tags a text names most specifically (longest matching tag wins), if any. */
export function ensembleFor(text: string, ensembles: readonly Ensemble[]): Ensemble | null {
  const t = normalise(text);
  let best: { ens: Ensemble; score: number } | null = null;
  for (const ens of ensembles) {
    let score = 0;
    for (const tag of [...ens.tags, ens.name]) {
      const words = normalise(tag);
      if (words.trim() && t.includes(words)) score = Math.max(score, words.trim().length);
    }
    if (score > (best?.score ?? 0)) best = { ens, score };
  }
  return best?.ens ?? null;
}

export function readWishes(requests: CrowdSummary['requests'], ensembles: readonly Ensemble[]): Wish[] {
  return requests.map((r) => {
    const lean = { intensity: 0, brightness: 0 };
    for (const word of normalise(r.text).trim().split(' ')) {
      const m = MOOD_WORDS[word];
      if (m?.intensity) lean.intensity = Math.max(-1, Math.min(1, lean.intensity + m.intensity));
      if (m?.brightness) lean.brightness = Math.max(-1, Math.min(1, lean.brightness + m.brightness));
    }
    return { requestId: r.id, support: r.support, ensemble: ensembleFor(r.text, ensembles), lean };
  });
}

const leans = (m: Mood) => m.intensity !== 0 || m.brightness !== 0;

/** A lean in the autopilot's words: "calmer", "brighter", "more intense and darker". */
export function leanWords(lean: Mood): string {
  const words = [lean.intensity < 0 ? 'calmer' : lean.intensity > 0 ? 'more intense' : '', lean.brightness < 0 ? 'darker' : lean.brightness > 0 ? 'brighter' : ''];
  return words.filter(Boolean).join(' and ');
}

const WORD_LEANS: Record<string, Partial<Mood>> = { calmer: { intensity: -1 }, 'more intense': { intensity: 1 }, darker: { brightness: -1 }, brighter: { brightness: 1 } };
const PENCILLED_LEAN = /^Pencilled in: the next side leans (.+)\.$/;

/** Whether moving from `from` to `to` goes the way `lean` asks, on every axis it names. */
export function follows(lean: Mood, from: Mood, to: Mood): boolean {
  return leans(lean) && (['intensity', 'brightness'] as const).every((axis) => lean[axis] === 0 || (to[axis] - from[axis]) * lean[axis] > 0);
}

export interface Promised {
  /** "Pencilled in: Jazz trio when this side turns over." */
  ensembles: { requestId: string; ensemble: Ensemble }[];
  /** "Pencilled in: the next side leans calmer." */
  leans: { requestId: string; lean: Mood }[];
}

/** Promises the autopilot itself made name the ensemble, or the lean, they promise the next side. */
export function readPromises(promises: CrowdSummary['promises'], ensembles: readonly Ensemble[]): Promised {
  const out: Promised = { ensembles: [], leans: [] };
  for (const p of promises) {
    const words = PENCILLED_LEAN.exec(p.publicReply)?.[1]?.split(' and ');
    if (words?.length && words.every((w) => w in WORD_LEANS)) {
      const lean = { intensity: 0, brightness: 0 };
      for (const w of words) Object.assign(lean, WORD_LEANS[w]);
      out.leans.push({ requestId: p.id, lean });
      continue;
    }
    const ens = ensembles.find((e) => p.publicReply.includes(`${e.name} `) || p.publicReply.endsWith(e.name));
    if (ens) out.ensembles.push({ requestId: p.id, ensemble: ens });
  }
  return out;
}

/** Support a mood request needs to lean the next side all the way (less leans it less). */
const FULL_SUPPORT = 3;

/**
 * The lean listeners asked the next side for in words, each axis -1..1: mood requests weighted by
 * support, and the leans the autopilot pencilled in, which count in full. Requests naming an ensemble
 * ask for that ensemble instead.
 */
export function askedLean(wishes: readonly Wish[], promised: Promised['leans']): Mood {
  const asks = [...wishes.filter((w) => !w.ensemble && leans(w.lean)).map((w) => ({ lean: w.lean, weight: w.support })), ...promised.map((p) => ({ lean: p.lean, weight: FULL_SUPPORT }))];
  const weight = asks.reduce((a, x) => a + x.weight, 0);
  if (!(weight > 0)) return { intensity: 0, brightness: 0 };
  const share = Math.min(1, weight / FULL_SUPPORT);
  const mean = (axis: keyof Mood) => (share * asks.reduce((a, x) => a + x.lean[axis] * x.weight, 0)) / weight;
  return { intensity: mean('intensity'), brightness: mean('brightness') };
}

const reply = (text: string) => (isPublicText(text) ? text.slice(0, 140) : 'Heard.');

export interface Opening {
  ensemble: Ensemble;
  sectionIndex: 0 | 1;
  /** Where the music was before the side opens (the side that ends, or its movement's baseline). */
  from: Mood;
}

/**
 * Decisions for the autopilot's plan: a wish it plays now is "this-plan", one it recognises but can't
 * play yet is pencilled in for the next side, everything else is declined kindly. A mood lean is
 * "this-plan" when the side this plan opens goes that way, pencilled in when no side opens yet, and
 * declined when the side that opens couldn't.
 */
export function decideWishes(wishes: readonly Wish[], promised: Promised, opening: Opening | null): RequestDecision[] {
  const out: RequestDecision[] = [];
  const decide = (requestId: string, decision: RequestDecision['decision'], text: string) =>
    out.push({ requestId, decision, sectionIndex: decision === 'this-plan' ? opening!.sectionIndex : null, mergedInto: null, publicReply: reply(text) });
  const went = (lean: Mood) => opening !== null && follows(lean, opening.from, opening.ensemble.mood);
  for (const p of promised.ensembles) {
    if (opening && p.ensemble.id === opening.ensemble.id) decide(p.requestId, 'this-plan', `As promised: ${p.ensemble.name} opens this side.`);
  }
  for (const p of promised.leans) {
    if (!opening) continue;
    const words = leanWords(p.lean);
    if (went(p.lean)) decide(p.requestId, 'this-plan', `As promised, ${words}: ${opening.ensemble.name} opens this side.`);
    else decide(p.requestId, 'declined', `This side couldn't go ${words} after all; the pull pad moves the music now.`);
  }
  for (const w of wishes) {
    const words = leanWords(w.lean);
    if (w.ensemble && opening && w.ensemble.id === opening.ensemble.id) decide(w.requestId, 'this-plan', `${w.ensemble.name}, coming right up on this side.`);
    else if (w.ensemble) decide(w.requestId, 'next-movement', `Pencilled in: ${w.ensemble.name} when this side turns over.`);
    else if (words && !opening) decide(w.requestId, 'next-movement', `Pencilled in: the next side leans ${words}.`);
    else if (words && went(w.lean)) decide(w.requestId, 'this-plan', `${words.charAt(0).toUpperCase()}${words.slice(1)}: ${opening!.ensemble.name} opens this side.`);
    else if (words) decide(w.requestId, 'declined', `This side couldn't go ${words}; the pull pad moves the music now.`);
    else decide(w.requestId, 'declined', 'The autopilot only knows its own crate, so this one waits.');
  }
  return out;
}
