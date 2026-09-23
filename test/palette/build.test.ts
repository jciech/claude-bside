import { describe, expect, it } from 'vitest';
import { centroidToBrightness, noteKeyToMidi, parseFontZones, playableRange, wavDuration } from '../../scripts/build-catalog.ts';
import { analyzeAudio, encodeWav, spectralCentroid } from '../../scripts/render-audio.ts';
import type { Audio } from '../../scripts/render-audio.ts';

const zone = (lo: number, hi: number, sec: number | 'error' | 'timeout' | null = 1, loop = false) => ({ lo, hi, loop, sec });

describe('playableRange', () => {
  it('uses the first matching zone like the soundfont loader (hi + 1 inclusive)', () => {
    expect(playableRange([zone(0, 59), zone(60, 127)])).toEqual([21, 108]);
    expect(playableRange([zone(30, 70)])).toEqual([30, 71]);
  });

  it('excludes notes without a zone and zones that fail to decode', () => {
    expect(playableRange([zone(24, 83), zone(84, 108, 'error')])).toEqual([24, 84]);
    expect(playableRange([zone(40, 90, 'timeout')])).toBeNull();
  });

  it('treats tiny unlooped zones as unplayable but tiny loops as single-cycle waves', () => {
    expect(playableRange([zone(0, 77), zone(78, 127, 0.007)])).toEqual([21, 78]);
    expect(playableRange([zone(0, 77), zone(78, 127, 0.007, true)])).toEqual([21, 108]);
  });

  it('prefers the run containing C4 over a longer one elsewhere', () => {
    expect(playableRange([zone(21, 40), zone(41, 50, 'error'), zone(52, 70)])).toEqual([52, 71]);
  });
});

describe('parseFontZones', () => {
  it('reads a webaudiofont preset as data', () => {
    const source = `console.log('load _tone_x');\nvar _tone_x={\n\tzones:[\n\t\t{midi:0,keyRangeLow:0,keyRangeHigh:59,loopStart:-1,loopEnd:0,file:'SUQz'},{keyRangeLow:60,keyRangeHigh:127,sample:'AAAA'}\n\t]\n};`;
    expect(parseFontZones(source)).toEqual([
      { midi: 0, keyRangeLow: 0, keyRangeHigh: 59, loopStart: -1, loopEnd: 0, file: 'SUQz' },
      { keyRangeLow: 60, keyRangeHigh: 127, sample: 'AAAA' },
    ]);
  });

  it('refuses anything that would need evaluation', () => {
    expect(() => parseFontZones(`var _tone_x={zones:[{keyRangeLow:alert(1)}]};`)).toThrow(/unsupported/);
  });
});

describe('helpers', () => {
  it('converts sample-map note keys to MIDI like Strudel (C4 = 60)', () => {
    expect(noteKeyToMidi('C4')).toBe(60);
    expect(noteKeyToMidi('A0')).toBe(21);
    expect(noteKeyToMidi('A#3')).toBe(58);
    expect(noteKeyToMidi('Ds1')).toBe(27);
    expect(noteKeyToMidi('b2')).toBe(47);
    expect(noteKeyToMidi('d2')).toBe(38);
  });

  it('maps centroid to brightness on a log scale', () => {
    expect(centroidToBrightness(80)).toBe(0);
    expect(centroidToBrightness(12000)).toBe(1);
    expect(centroidToBrightness(40000)).toBe(1);
    expect(centroidToBrightness(980)).toBeCloseTo(0.5, 1);
  });

  it('reads WAV durations from a header', () => {
    const audio: Audio = { sampleRate: 48000, channels: [new Float32Array(24000), new Float32Array(24000)] };
    const wav = encodeWav(audio);
    expect(wavDuration(wav.subarray(0, 64), wav.length)).toBe(0.5);
    expect(wavDuration(Buffer.from('not a wav at all'), 100)).toBeNull();
  });
});

describe('audio analysis', () => {
  const tone = (hz: number, amplitude: number, seconds = 1, sampleRate = 44100): Audio => {
    const n = seconds * sampleRate;
    const data = Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate));
    return { sampleRate, channels: [data, data.slice()] };
  };

  it('measures peak, RMS, clipping and centroid of a sine', () => {
    const stats = analyzeAudio(tone(1000, 0.5), { bpm: 240 });
    expect(stats.peakDb).toBeCloseTo(-6, 0);
    expect(stats.rmsDb).toBeCloseTo(-9, 0);
    expect(stats.clipPct).toBe(0);
    expect(Math.abs(stats.centroidHz - 1000)).toBeLessThan(60);
    expect(stats.barRmsDb).toHaveLength(1);
    expect(analyzeAudio(tone(100, 1.5)).clipPct).toBeGreaterThan(0);
  });

  it('puts white noise near a quarter of the sample rate and silence at 0', () => {
    let seed = 1;
    const noise = Float32Array.from({ length: 44100 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
    const centroid = spectralCentroid({ sampleRate: 44100, channels: [noise, noise] });
    expect(centroid).toBeGreaterThan(9500);
    expect(centroid).toBeLessThan(12500);
    expect(spectralCentroid({ sampleRate: 44100, channels: [new Float32Array(4096), new Float32Array(4096)] })).toBe(0);
  });

  it('writes interleaved 32-bit float WAV without clamping', () => {
    const audio = tone(440, 1.2, 0.1);
    const wav = encodeWav(audio);
    expect(wav.readUInt16LE(20)).toBe(3);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(44100);
    expect(wav.readUInt32LE(40)).toBe(audio.channels[0].length * 8);
    expect(wav.readFloatLE(44 + 123 * 8 + 4)).toBeCloseTo(audio.channels[1][123]!, 6);
    expect(Math.max(...Array.from({ length: 200 }, (_, i) => wav.readFloatLE(44 + i * 8)))).toBeGreaterThan(1);
  });
});
