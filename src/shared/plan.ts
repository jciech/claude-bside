// The Plan: what a composer (Claude, a script, or a human via the CLI) submits to the conductor.
// zod is the source of truth; `planToolSchema()` derives the JSON Schema given to Claude as a strict
// tool input. Structured outputs cannot express numeric/length bounds, so those are stripped from
// the Claude-facing schema and enforced here (and by the checker's cross-field rules).
import { z } from 'zod';
import {
  ARC_SHAPES,
  BPM_MAX,
  BPM_MIN,
  GROOVES,
  MAX_PARTS_PER_SECTION,
  PART_ID_PATTERN,
  PART_ROLES,
  SECTION_LENGTHS,
  SECTION_ROLES,
  TRANSITION_TYPES,
} from './music.ts';

const unit = z.number().min(0).max(1);

export const SpanSchema = z
  .object({
    start: unit.describe('Value at bar 0 (0..1).'),
    end: unit.describe('Value at the last bar (0..1).'),
  })
  .strict();

export const KnobSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,15}$/)
      .describe('Knob name as used in code: knob("cut"). Scoped to this part.'),
    default: z.number().describe('Initial value.'),
    min: z.number(),
    max: z.number(),
    follows: z
      .enum(['none', 'brightness', 'intensity'])
      .describe('If not "none", the room steering pad nudges this knob within min..max (fast lane).'),
  })
  .strict();

export const AutomationSchema = z
  .object({
    target: z.string().describe('"level" or "knob:<name>".'),
    fromBar: z.number().int().min(0),
    toBar: z.number().int().min(0),
    from: z.number(),
    to: z.number(),
    curve: z.enum(['linear', 'exp']),
  })
  .strict();

export const PartPlanSchema = z
  .object({
    id: z
      .string()
      .regex(PART_ID_PATTERN)
      .describe('Stable part id, lowercase, e.g. "kick", "bass", "keys2". Reuse an id to continue a part.'),
    role: z.enum(PART_ROLES),
    code: z
      .string()
      .max(1200)
      .nullable()
      .describe(
        'ONE Strudel expression producing a pattern (no labels, no setcps, no samples(), no .orbit()). ' +
          'Double-quoted strings are mini-notation. Break long chains over lines, one method per line. ' +
          'null = carry the code of the part with this id from the previous section unchanged.',
      ),
    level: unit.describe('Fader level 0..1 (multiplies the part; your own .gain() stays intact).'),
    enterBar: z.number().int().min(0).describe('Bar (section-relative) where the part starts sounding.'),
    exitBar: z.number().int().min(1).nullable().describe('Bar where it stops, or null to play to the end.'),
    knobs: z.array(KnobSchema).max(4),
    automation: z.array(AutomationSchema).max(6),
    duck: z
      .object({
        target: z.string().regex(PART_ID_PATTERN).describe('Part id to duck (sidechain) when this part hits.'),
        depth: unit,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const SectionPlanSchema = z
  .object({
    name: z.string().min(1).max(40).describe('Evocative track title shown to listeners.'),
    role: z.enum(SECTION_ROLES),
    bars: z.literal(SECTION_LENGTHS).describe('Section length in bars (1 bar = 1 cycle).'),
    bpm: z.number().min(BPM_MIN).max(BPM_MAX),
    tempoRampBars: z
      .number()
      .int()
      .min(0)
      .max(16)
      .describe('If bpm differs from the current tempo, ramp over this many bars (0 = switch at bar 0).'),
    scale: z.string().max(40).describe('Strudel scale name with root, colon-separated, e.g. "D:dorian", "F#:minor".'),
    chords: z.string().max(120).nullable().describe('Chord cycle for reference, e.g. "<Dm9 G13 C^7>".'),
    targets: z
      .object({
        intensity: SpanSchema,
        brightness: SpanSchema,
        density: SpanSchema,
        tension: SpanSchema,
      })
      .strict(),
    transitionIn: z
      .object({
        type: z.enum(TRANSITION_TYPES),
        bars: z.number().int().min(0).max(16),
      })
      .strict(),
    parts: z.array(PartPlanSchema).min(1).max(MAX_PARTS_PER_SECTION),
    reprise: z
      .string()
      .nullable()
      .describe('Id of an earlier section this one deliberately calls back to (bypasses similarity checks).'),
    publicNote: z
      .string()
      .max(280)
      .describe('Liner note shown to listeners at bar 0: what this section is doing and why, in your voice.'),
  })
  .strict();

export const MovementPlanSchema = z
  .object({
    name: z.string().min(1).max(40).describe('Name of the new movement (a "side" of the record).'),
    bpm: z.number().min(BPM_MIN).max(BPM_MAX),
    scale: z.string().max(40),
    groove: z.enum(GROOVES),
    arcShape: z.enum(ARC_SHAPES),
    palette: z.array(z.string()).max(16).describe('Sound ids this movement is built from (catalog ids).'),
    signature: z.array(z.string()).max(3).describe('Up to 3 signature sounds exempt from cooldown in this movement.'),
    blurb: z.string().max(200).describe('One or two sentences introducing the movement to listeners.'),
  })
  .strict();

export const ForkPlanSchema = z
  .object({
    prompt: z.string().max(120).describe('Question put to the room, e.g. "Where next?"'),
    options: z
      .array(
        z
          .object({
            id: z.enum(['A', 'B', 'C']),
            label: z.string().max(40),
            description: z.string().max(140),
            kind: z.enum(['continue', 'contrast', 'surprise', 'request']),
          })
          .strict(),
      )
      .min(2)
      .max(3),
    defaultOption: z.enum(['A', 'B', 'C']),
  })
  .strict();

export const RequestDecisionSchema = z
  .object({
    requestId: z.string(),
    decision: z.enum(['now', 'next-section', 'next-movement', 'fork-option', 'merged', 'declined']),
    publicReply: z
      .string()
      .max(140)
      .describe('Shown to the room. Paraphrase the wish; never quote listener text verbatim.'),
  })
  .strict();

export const PlanSchema = z
  .object({
    sections: z.array(SectionPlanSchema).min(1).max(2).describe('The next 1-2 sections, in playing order.'),
    movement: MovementPlanSchema.nullable().describe('Only when asked to start a new movement; otherwise null.'),
    fork: ForkPlanSchema.nullable().describe('Optionally offer the room a vote on what follows these sections.'),
    requestDecisions: z.array(RequestDecisionSchema).max(10),
    announcement: z.string().max(90).nullable().describe('Optional one-liner broadcast at the first section start.'),
    rationale: z.string().max(1200).describe('Private reasoning for the log and the next turn. Not shown publicly.'),
  })
  .strict();

export type SpanPlan = z.infer<typeof SpanSchema>;
export type Knob = z.infer<typeof KnobSchema>;
export type Automation = z.infer<typeof AutomationSchema>;
export type PartPlan = z.infer<typeof PartPlanSchema>;
export type SectionPlan = z.infer<typeof SectionPlanSchema>;
export type MovementPlan = z.infer<typeof MovementPlanSchema>;
export type ForkPlan = z.infer<typeof ForkPlanSchema>;
export type RequestDecision = z.infer<typeof RequestDecisionSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/** Input of the `audition` tool: try code before committing it. */
export const AuditionInputSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            id: z.string().regex(PART_ID_PATTERN),
            role: z.enum(PART_ROLES),
            code: z.string().max(1200),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PARTS_PER_SECTION),
    bpm: z.number().min(BPM_MIN).max(BPM_MAX).nullable(),
    scale: z.string().max(40).nullable().describe('If set, pitched parts are checked for key fit.'),
  })
  .strict();
export type AuditionInput = z.infer<typeof AuditionInputSchema>;

const UNSUPPORTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  '$schema',
  'format',
];

/** Strips keywords structured outputs can't enforce, and closes every object. */
export function toClaudeSchema(schema: unknown): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED_KEYWORDS.includes(k)) continue;
      out[k] = walk(v);
    }
    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties);
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

export function planToolSchema(): Record<string, unknown> {
  return toClaudeSchema(z.toJSONSchema(PlanSchema, { target: 'draft-2020-12' }));
}

export function auditionToolSchema(): Record<string, unknown> {
  return toClaudeSchema(z.toJSONSchema(AuditionInputSchema, { target: 'draft-2020-12' }));
}
