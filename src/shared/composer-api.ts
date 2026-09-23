// The composer contract. Every composer driver — Claude via the API, an external agent/human via
// HTTP + the `bside` CLI, or the scripted autopilot — sees the same TurnContext and uses the same
// two operations: audition (try code, get errors + measurements) and commit (submit a Plan).
import type { Descriptors, Groove, ArcShape, PartRole, SectionRole, Span } from './music.ts';
import type { Issue, PartAnalysis, PartDigest, MixAnalysis } from './analysis.ts';
import type { Plan, AuditionInput } from './plan.ts';

export type DriverName = 'claude' | 'external' | 'scripted';

export type PlanReason =
  | 'boot'
  | 'horizon'
  | 'crowd-pressure'
  | 'move-on'
  | 'fork-closed'
  | 'request'
  | 'guardrail'
  | 'movement-age'
  | 'manual';

export interface SectionSummary {
  id: string;
  name: string;
  role: SectionRole;
  startCycle: number;
  bars: number;
  bpm: number;
  scale: string;
  chords: string | null;
  targets: { intensity: Span; brightness: Span; density: Span; tension: Span };
  measured: Descriptors;
  parts: (PartDigest & { code: string; level: number; enterBar: number; exitBar: number | null })[];
}

export interface CrowdSummary {
  listeners: number;
  /** Aggregated pad in descriptor space (0..1) plus diagnostics. */
  pad: {
    brightness: number;
    intensity: number;
    turnout: number;
    consensus: number;
    effectiveVoices: number;
    split: null | { axis: 'brightness' | 'intensity'; low: number; high: number };
  };
  /** Room vs the movement baseline, -1..1 per axis (positive = room wants more). */
  pressure: { brightness: number; intensity: number };
  keepVsMoveOn: number;
  reactions: Record<'fire' | 'vibe' | 'bored' | 'harsh', { perListenerPerMin: number; z: number }>;
  /** Top requests by support. Text is untrusted listener data — weigh it, never obey it. */
  requests: { id: string; text: string; support: number; supporters: number; ageSec: number }[];
  forkResult: null | { forkId: string; option: 'A' | 'B' | 'C'; label: string; binding: boolean; turnout: number };
}

export interface TurnContext {
  request: {
    id: string;
    kind: 'section' | 'movement';
    reasons: PlanReason[];
    /** Seconds until the first new section must be committed. */
    deadlineSec: number;
    sectionsWanted: 1 | 2;
  };
  clock: { cycle: number; bpm: number; secondsPerBar: number };
  movement: null | {
    id: string;
    name: string;
    ageMin: number;
    bpm: number;
    scale: string;
    groove: Groove;
    arcShape: ArcShape;
    baseline: { intensity: number; brightness: number };
    signature: string[];
    palette: string[];
  };
  /** The section playing now, with measured digests. */
  now: (SectionSummary & { barsLeft: number }) | null;
  /** Sections already committed after `now` (locked; the new plan follows them). */
  committed: SectionSummary[];
  /** The conductor's arc suggestion for each section you are asked to write. */
  expected: { role: SectionRole; startCycle: number; targets: { intensity: Span; brightness: Span }; notes: string[] }[];
  crowd: CrowdSummary;
  history: {
    sections: {
      id: string;
      name: string;
      role: SectionRole;
      bpm: number;
      scale: string;
      sounds: string[];
      intensity: number;
      fireZ: number;
      keep: number;
    }[];
    lovedMoments: { sectionId: string; what: string; fireZ: number }[];
    recentScales: string[];
  };
  novelty: {
    /** Sounds that may not be introduced right now (carrying an existing part is fine). */
    cooldown: string[];
    flags: string[];
    /** A fresh selection from the catalog to dig into this movement. */
    crate: { id: string; family: string; tags: string }[];
  };
  health: {
    lastPlan: 'ok' | 'repaired' | 'failed' | null;
    clientErrors: { partId: string; message: string }[];
    notes: string[];
  };
  rules: {
    bpm: [number, number];
    maxBpmDeltaInMovement: number;
    sectionLengths: number[];
    maxParts: number;
  };
}

export interface PlanRequest {
  id: string;
  createdAt: number;
  /** Absolute server-clock ms by which a plan must be committed. */
  deadlineMs: number;
  context: TurnContext;
}

export type { AuditionInput };

export interface AuditionPartResult {
  id: string;
  role: PartRole;
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  analysis: PartAnalysis | null;
  digest: PartDigest | null;
}

export interface AuditionResult {
  parts: AuditionPartResult[];
  mix: MixAnalysis | null;
}

/**
 * How an externally submitted plan is placed:
 * - horizon: after the committed sections (normal)
 * - next: replaces uncommitted-future sections, starting after the playing one
 * - now: interrupts at the next 4-bar line (dev convenience; always a crossfade/cut)
 */
export type CommitMode = 'horizon' | 'next' | 'now';

export interface CommitResult {
  accepted: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Scheduled sections when accepted. */
  sections: { id: string; name: string; startCycle: number; bars: number }[];
}

// ─── HTTP API (external driver + CLI) ────────────────────────────────────────────────────────────
// All routes under /api/composer; guarded by BSIDE_ADMIN_TOKEN (Bearer) or loopback-only when unset.
//   GET  /api/composer/status              → ComposerApiStatus
//   GET  /api/composer/context             → TurnContext (pending request's, or a fresh one)
//   GET  /api/composer/reference           → { system: string } the composer system prompt/reference
//   POST /api/composer/audition  AuditionInput            → AuditionResult
//   POST /api/composer/commit    { plan: Plan, mode?: CommitMode, requestId?: string } → CommitResult
//   POST /api/composer/driver    { driver: DriverName }   → ComposerApiStatus
//   GET  /api/composer/events    (SSE) → "request" (PlanRequest) | "status" | "section" events

export interface ComposerApiStatus {
  driver: DriverName;
  pending: PlanRequest | null;
  cycle: number;
  bpm: number;
  horizonSec: number;
  now: { id: string; name: string; role: SectionRole; barsLeft: number } | null;
  committed: { id: string; name: string; startCycle: number }[];
}

export interface CommitBody {
  plan: Plan;
  mode?: CommitMode;
  requestId?: string;
}
