// The Plan: what a composer (Claude, a script, or a human via the CLI) submits to the conductor.
// zod is the source of truth; `planToolSchema()` derives the JSON Schema given to Claude as a strict
// tool input. Structured outputs cannot express numeric/length bounds, so those are stripped from
// the Claude-facing schema and enforced here (and by the conductor's cross-field rules).
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
const partId = z.string().regex(PART_ID_PATTERN);

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
      .describe('Knob name as written in code: knob("cut"). Scoped to this part.'),
    default: z.number().describe('Value when no automation lane covers the bar.'),
    min: z.number(),
    max: z.number(),
    follows: z
      .enum(['none', 'brightness', '-brightness', 'intensity', '-intensity'])
      .describe(
        'Fast lane: the room steering pad moves this knob by up to ±half its range as the room leans ' +
          'brighter/darker or more/less intense ("-" inverts, e.g. hats thinning as the room calms).',
      ),
  })
  .strict();

export const AutomationSchema = z
  .object({
    target: z.string().describe('"level" or "knob:<name>".'),
    fromBar: z.number().int().min(-8),
    toBar: z.number().int().min(-7),
    from: z.number(),
    to: z.number(),
    curve: z.enum(['linear', 'exp']).describe('exp is geometric (for level: linear in dB).'),
  })
  .strict();

export const DuckSchema = z
  .object({
    targets: z.array(partId).min(1).max(3).describe('Part ids pushed down (sidechained) when this part hits.'),
    depth: unit,
    releaseSec: z.number().min(0.05).max(0.5).describe('How fast the ducked parts return to full level.'),
  })
  .strict();

export const PartPlanSchema = z
  .object({
    id: partId.describe('Stable part id, lowercase, e.g. "kick", "bass", "keys2". Reuse an id to continue a part.'),
    role: z.enum(PART_ROLES),
    code: z
      .string()
      .max(1200)
      .nullable()
      .describe(
        'ONE Strudel expression producing a pattern (no labels, no setcps, no samples(), no .orbit()). ' +
          'Double-quoted strings are mini-notation. One method per line after the source call. ' +
          'null = carry this part id from the previous section: same code, same knobs, and it keeps ' +
          'playing without interruption (its phrase continues) unless restart is true.',
      ),
    restart: z
      .boolean()
      .describe('Only for carried parts (code null): true restarts the pattern at this section\'s bar 0; false continues it.'),
    chromatic: z
      .boolean()
      .describe('Pitched part intentionally uses out-of-scale notes (blues, approach tones, altered chords): no key-fit error.'),
    level: unit.describe('Fader 0..1. Multiplies the part after its own .gain(); faded smoothly by the engine.'),
    enterBar: z
      .number()
      .int()
      .min(-8)
      .describe(
        'Score bar where the part starts sounding. Negative = a pickup that plays over the end of the ' +
          'previous section (fills, reverse cymbals). Pattern time is not restarted at enterBar.',
      ),
    exitBar: z.number().int().min(1).nullable().describe('Score bar where it stops (released smoothly), or null to play on.'),
    knobs: z.array(KnobSchema).max(4).describe('Declare every knob("…") the code uses. For carried parts: [] inherits.'),
    automation: z.array(AutomationSchema).max(6),
    duck: DuckSchema.nullable(),
  })
  .strict();

export const SectionPlanSchema = z
  .object({
    name: z.string().min(1).max(40).describe('Evocative track title shown to listeners.'),
    role: z.enum(SECTION_ROLES),
    bars: z.literal(SECTION_LENGTHS).describe('Composed length in bars (1 bar = 1 cycle).'),
    bpm: z.number().min(BPM_MIN).max(BPM_MAX),
    tempoRampBars: z
      .number()
      .int()
      .min(0)
      .max(16)
      .describe('If bpm differs from the tempo before, ramp over this many bars (0 = switch). ≤ bars.'),
    tempoRampAt: z.enum(['start', 'end']).describe('Ramp at the start of the section, or into its end (ritardando/accelerando).'),
    scale: z
      .string()
      .max(80)
      .describe('Strudel scale with root, colon-separated: "D:dorian". May alternate per bar: "<D:dorian G:mixolydian>".'),
    chords: z.string().max(120).nullable().describe('Chord cycle for reference, Strudel spelling: "<Dm9 G13 C^7>".'),
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
        bars: z.number().int().min(0).max(16).describe('crossfade ≤ 8, breath ≤ 2; ≤ half of either section.'),
      })
      .strict(),
    parts: z.array(PartPlanSchema).min(1).max(MAX_PARTS_PER_SECTION),
    reprise: z
      .string()
      .nullable()
      .describe('Id of an earlier section this one deliberately calls back to (exempt from similarity checks).'),
    publicNote: z
      .string()
      .max(280)
      .describe('Liner note shown to listeners at bar 0: what this section is doing and why, in your voice.'),
  })
  .strict();

export const FormStepSchema = z
  .object({
    role: z.enum(SECTION_ROLES),
    bars: z.literal(SECTION_LENGTHS),
    note: z.string().max(80),
  })
  .strict();

export const MovementPlanSchema = z
  .object({
    name: z.string().min(1).max(40).describe('Name of the new movement (a "side" of the record).'),
    startsAtSection: z
      .union([z.literal(0), z.literal(1)])
      .describe('Which of this plan\'s sections opens the movement; a section before it closes the old one.'),
    bpm: z.number().min(BPM_MIN).max(BPM_MAX).describe('Tempo centre; sections stay within ±4.'),
    scale: z.string().max(40),
    groove: z.enum(GROOVES),
    arcShape: z.enum(ARC_SHAPES),
    form: z.array(FormStepSchema).max(12).describe('Revisable sketch of the movement\'s sections.'),
    palette: z.array(z.string()).max(16).describe('Sound ids this movement is built from (catalog ids).'),
    signature: z.array(z.string()).max(3).describe('Up to 3 signature sounds, exempt from cooldown in this movement.'),
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
            requestId: z.string().nullable().describe('For kind "request": the request this option would honour.'),
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
    decision: z.enum(['this-plan', 'next-movement', 'fork-option', 'merged', 'declined']),
    sectionIndex: z
      .union([z.literal(0), z.literal(1)])
      .nullable()
      .describe('For "this-plan": which of this plan\'s sections honours it.'),
    mergedInto: z.string().nullable().describe('For "merged": the request id it joins.'),
    publicReply: z
      .string()
      .max(140)
      .describe('Shown to the room. Paraphrase the wish; never quote listener text verbatim.'),
  })
  .strict();

export const MotifSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
    role: z.enum(PART_ROLES),
    code: z.string().max(600),
  })
  .strict();

export const PlanSchema = z
  .object({
    sections: z.array(SectionPlanSchema).min(1).max(2).describe('The next 1-2 sections, in playing order.'),
    movement: MovementPlanSchema.nullable().describe('Only when the request asks for a movement; otherwise null.'),
    fork: ForkPlanSchema.nullable().describe('Optionally offer the room a vote on what follows (only when allowed).'),
    requestDecisions: z.array(RequestDecisionSchema).max(10),
    motifs: z
      .array(MotifSchema)
      .max(3)
      .describe('Named musical ideas to remember for this movement (reusing them never trips similarity).'),
    announcement: z.string().max(90).nullable().describe('Optional one-liner broadcast at the first section start.'),
    rationale: z
      .string()
      .max(1200)
      .describe('Private notes for your next turn (intent, what comes next). Not shown publicly.'),
  })
  .strict();

export type SpanPlan = z.infer<typeof SpanSchema>;
export type Knob = z.infer<typeof KnobSchema>;
export type Automation = z.infer<typeof AutomationSchema>;
export type Duck = z.infer<typeof DuckSchema>;
export type PartPlan = z.infer<typeof PartPlanSchema>;
export type SectionPlan = z.infer<typeof SectionPlanSchema>;
export type FormStep = z.infer<typeof FormStepSchema>;
export type MovementPlan = z.infer<typeof MovementPlanSchema>;
export type ForkPlan = z.infer<typeof ForkPlanSchema>;
export type RequestDecision = z.infer<typeof RequestDecisionSchema>;
export type Motif = z.infer<typeof MotifSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/** Input of the `audition` tool: try code before committing it. */
export const AuditionInputSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            id: partId,
            role: z.enum(PART_ROLES),
            code: z.string().max(1200),
            knobs: z.array(KnobSchema).max(4),
            chromatic: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PARTS_PER_SECTION),
    bpm: z.number().min(BPM_MIN).max(BPM_MAX).nullable(),
    scale: z.string().max(80).nullable().describe('If set, pitched parts are checked for key fit.'),
    bars: z.literal(SECTION_LENGTHS).nullable().describe('Bars to analyse (default 16).'),
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
