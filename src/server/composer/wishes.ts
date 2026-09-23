// How the autopilot reads listener requests: as data, matched against its own ensembles' tags and a
// few mood words. It never follows instructions in them and never repeats their text; every reply
// is built from the library's own vocabulary.
import type { CrowdSummary } from '../../shared/composer-api.ts';
import type { RequestDecision } from '../../shared/plan.ts';
import { isPublicText } from '../../shared/text.ts';
import type { Ensemble } from './library/index.ts';

export interface Wish {
  requestId: string;
  support: number;
  ensemble: Ensemble | null;
  /** Mood leaning in pad space, each -1..1 (0 when the text names none). */
  lean: { intensity: number; brightness: number };
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

/** Promises the autopilot itself made ("Pencilled in: Jazz trio …") name the ensemble they promise. */
export function promisedEnsembles(promises: CrowdSummary['promises'], ensembles: readonly Ensemble[]): { requestId: string; ensemble: Ensemble }[] {
  const out: { requestId: string; ensemble: Ensemble }[] = [];
  for (const p of promises) {
    const ens = ensembles.find((e) => p.publicReply.includes(`${e.name} `) || p.publicReply.endsWith(e.name));
    if (ens) out.push({ requestId: p.id, ensemble: ens });
  }
  return out;
}

const reply = (text: string) => (isPublicText(text) ? text.slice(0, 140) : 'Heard.');

/**
 * Decisions for the autopilot's plan: a wish it plays now is "this-plan", one it recognises but
 * can't play yet is pencilled in for the next side, everything else is declined kindly.
 */
export function decideWishes(
  wishes: readonly Wish[],
  promised: readonly { requestId: string; ensemble: Ensemble }[],
  playing: { ensemble: Ensemble; sectionIndex: 0 | 1; opensMovement: boolean } | null,
): RequestDecision[] {
  const out: RequestDecision[] = [];
  for (const p of promised) {
    if (playing?.opensMovement && p.ensemble.id === playing.ensemble.id) {
      out.push({ requestId: p.requestId, decision: 'this-plan', sectionIndex: playing.sectionIndex, mergedInto: null, publicReply: reply(`As promised: ${p.ensemble.name} opens this side.`) });
    }
  }
  for (const w of wishes) {
    if (w.ensemble && playing && w.ensemble.id === playing.ensemble.id && playing.opensMovement) {
      out.push({ requestId: w.requestId, decision: 'this-plan', sectionIndex: playing.sectionIndex, mergedInto: null, publicReply: reply(`${w.ensemble.name}, coming right up on this side.`) });
    } else if (w.ensemble) {
      out.push({ requestId: w.requestId, decision: 'next-movement', sectionIndex: null, mergedInto: null, publicReply: reply(`Pencilled in: ${w.ensemble.name} when this side turns over.`) });
    } else if (w.lean.intensity || w.lean.brightness) {
      out.push({ requestId: w.requestId, decision: 'declined', sectionIndex: null, mergedInto: null, publicReply: reply('The autopilot leans the next side that way; the pull pad moves it faster.') });
    } else {
      out.push({ requestId: w.requestId, decision: 'declined', sectionIndex: null, mergedInto: null, publicReply: reply('The autopilot only knows its own crate, so this one waits.') });
    }
  }
  return out;
}
