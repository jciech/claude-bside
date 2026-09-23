import type { Knob } from '../../../shared/plan.ts';

/** Part code in the house style: the source call, then one method per line. */
export const chain = (source: string, ...methods: string[]): string => [source, ...methods.map((m) => `  .${m}`)].join('\n');

/** A low-pass knob that opens as the room leans brighter. */
export const cutKnob = (value: number, min: number, max: number): Knob => ({ name: 'cut', default: value, min, max, follows: 'brightness' });

/** A send knob that grows as the room calms down (more space, fewer hits). */
export const wetKnob = (value: number, min: number, max: number): Knob => ({ name: 'wet', default: value, min, max, follows: '-intensity' });
