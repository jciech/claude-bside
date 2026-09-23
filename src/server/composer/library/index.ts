import { AMBIENT } from './ambient.ts';
import { BREAKS } from './breaks.ts';
import { DOWNTEMPO } from './downtempo.ts';
import { HOUSE } from './house.ts';
import { SYNTH } from './synth.ts';
import { TECHNO } from './techno.ts';
import type { Ensemble } from './types.ts';
import { WORLD } from './world.ts';

export type { Ensemble, Layer, TemplatePart } from './types.ts';

/** Every ensemble, in a fixed order (deterministic picks depend on it). */
export const LIBRARY: readonly Ensemble[] = [...AMBIENT, ...HOUSE, ...TECHNO, ...BREAKS, ...DOWNTEMPO, ...SYNTH, ...WORLD];
