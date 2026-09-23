// "Did you mean" for names the composer got wrong: Levenshtein distance plus a map of the words
// LLMs reach for that Strudel spells differently.

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** Common hallucinated method/function names → the Strudel name. */
export const NAME_SYNONYMS: Readonly<Record<string, string>> = {
  reverb: 'room',
  reverbsize: 'roomsize',
  roomSize: 'roomsize',
  wet: 'room',
  lowpass: 'lpf',
  lowPass: 'lpf',
  highpass: 'hpf',
  highPass: 'hpf',
  bandpass: 'bpf',
  filter: 'lpf',
  cutoffFreq: 'lpf',
  q: 'lpq',
  volume: 'gain',
  vol: 'gain',
  level: 'gain',
  velocityCurve: 'velocity',
  echo: 'delay',
  delayTime: 'delaytime',
  delayFeedback: 'delayfeedback',
  feedback: 'delayfeedback',
  reverse: 'rev',
  backwards: 'rev',
  repeat: 'ply',
  stutter: 'ply',
  distortion: 'distort',
  overdrive: 'distort',
  bitcrush: 'crush',
  panning: 'pan',
  stereo: 'pan',
  pitch: 'note',
  notes: 'note',
  sample: 's',
  samples: 's',
  instrument: 's',
  synth: 's',
  voiceLeading: 'voicing',
  chords: 'chord',
  arpeggio: 'arp',
  arpeggiate: 'arp',
  attackTime: 'attack',
  decayTime: 'decay',
  sustainLevel: 'sustain',
  releaseTime: 'release',
  envelope: 'adsr',
  voices: 'unison',
  detuning: 'detune',
  speedUp: 'fast',
  faster: 'fast',
  slower: 'slow',
  slowDown: 'slow',
  sequence: 'seq',
  random: 'rand',
  randomize: 'shuffle',
  humanize: 'late',
  swingAmount: 'swingBy',
  transposeBy: 'transpose',
  key: 'scale',
  mode: 'scale',
  every_n: 'every',
  sometimesDo: 'sometimes',
};

export const synonymOf = (name: string): string | undefined =>
  Object.hasOwn(NAME_SYNONYMS, name) ? NAME_SYNONYMS[name] : Object.hasOwn(NAME_SYNONYMS, name.toLowerCase()) ? NAME_SYNONYMS[name.toLowerCase()] : undefined;

/** Up to `max` close names from `pool`, synonym first. */
export function suggest(name: string, pool: Iterable<string>, max = 3): string[] {
  const out: string[] = [];
  const syn = synonymOf(name);
  const candidates = [...pool];
  if (syn && candidates.includes(syn)) out.push(syn);
  const lower = name.toLowerCase();
  const limit = out.length ? 1 : Math.max(1, Math.floor(name.length / 3));
  const scored: [number, string][] = [];
  for (const c of candidates) {
    const d = levenshtein(lower, c.toLowerCase());
    if (d <= limit) scored.push([d, c]);
    else if (lower.length >= 4 && c.toLowerCase().startsWith(lower)) scored.push([limit + 1, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  for (const [, c] of scored) if (!out.includes(c)) out.push(c);
  return out.slice(0, max);
}
