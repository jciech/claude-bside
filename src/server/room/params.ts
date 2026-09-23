// Crowd model parameters (docs/ARCHITECTURE.md §8). Simulated in test/room/crowd-sim.test.ts.

export const CROWD = {
  /** Weight w = trust × presence; trust ramps over audible listening time. */
  trustStart: 0.35,
  trustRampMs: 120_000,
  hiddenPresence: 0.5,
  /** Inputs from a listener count only after this much audible listening. */
  warmupMs: 10_000,
  /**
   * Total weight of one network (/24 IPv4, config.ipv6Prefix IPv6); it also counts as at most this
   * many voices in the Kish n_eff quorums. Not for a network holding more than half of the capped
   * weight: that one is the room, and its listeners count one by one.
   */
  networkWeightCap: 2,
  /** Silent-majority prior: a non-participant counts as a β-weight vote for "as it is". */
  silentPrior: 0.25,
  /** Pad freshness s = exp(−age / padFreshMs); an untouched puck relaxes to centre after padRelaxMs. */
  padFreshMs: 120_000,
  padRelaxMs: 90_000,
  /** Below this freshness a gesture no longer counts as participation. */
  minFreshness: 0.05,
  split: { minPoints: 4, minShare: 0.25, minGap: 1 },
  /** Early replan hysteresis, in bars, against the movement baseline (pad coordinates). */
  pressureOn: 0.45,
  pressureOff: 0.25,
  pressureHoldBars: 24,
  replanCooldownBars: 32,
  pressureQuorum: 3,
  /**
   * Kish n_eff only reaches a head count when every voice weighs the same, and freshness decays from
   * each listener's own gesture: a quorum q is met at n_eff ≥ min(q, N) − quorumSlack. One network
   * (≤ 2 voices) still can't reach a quorum of 3.
   */
  quorumSlack: 0.5,
  /** Keep ballots: freshness exp(−age / keepFreshMs), EMA τ keepTauMs, act at |K| > keepOn for keepHoldBars. */
  keepFreshMs: 90_000,
  keepTauMs: 10_000,
  keepOn: 0.35,
  keepHoldBars: 8,
  keepQuorum: 2,
  /** Reactions: one counted per type per listener per window; z against an EW baseline. */
  reactionWindowBars: 4,
  reactionBaselineMs: 15 * 60_000,
  reactionPrior: { mean: 0.05, sd: 0.05 },
  reactionMinSd: 0.05,
  reactionMinMinutes: 0.5,
  /** A single listener's contribution to a section's reaction rate is capped at this. */
  reactionMaxPerListenerPerMin: 1,
  reactionZ: 2,
  harshShare: 0.2,
  harshWindowBars: 8,
  harshCooldownBars: 16,
  etchBars: 16,
  maxEtches: 96,
  maxGhosts: 64,
  ghostStep: 0.05,
  requests: {
    supportTauMs: 6 * 60_000,
    expireMs: 15 * 60_000,
    /** Decided promises (next-movement, fork-option, planned) that never play are dropped after this. */
    promiseExpireMs: 45 * 60_000,
    unseenNoteMs: 5 * 60_000,
    roomRate: { perSec: 30 / 60, burst: 30 },
    /** One network's share of the room's budget. */
    networkRate: { perSec: 5 / 60, burst: 5 },
    surgeSupport: 3,
    topK: 5,
    ownCards: 10,
    publicCards: 20,
    maxKept: 2000,
  },
  fork: { bindingShare: 0.5, bindingTurnout: 0.2, advisoryShare: 0.4, advisoryTurnout: 0.1 },
  /** A client error is corroborated once trusted listeners on this many networks report it (or two on the room's own network). */
  telemetry: { maxSampled: 20, maxSampledPerNetwork: 2, trustedTrust: 0.6, corroborateNetworks: 2, maxCorroborated: 8 },
  frameMs: 250,
  frameKeepaliveMs: 5_000,
  forkTallyMs: 1_000,
  forgetAfterMs: 10 * 60_000,
  /** Beyond this many listeners gone from one network, the longest gone are forgotten early. */
  maxDetachedPerNetwork: 64,
  maxListeners: 20_000,
  maxSocketsPerListener: 8,
  heartbeatRate: { perSec: 1, burst: 5 },
  identity: { persistEveryMs: 60_000, keep: 5_000, maxAgeMs: 7 * 24 * 60 * 60_000 },
} as const;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** EMA time constant of the room pull: a solo listener moves it in seconds, a big room deliberately. */
export const roomTauSec = (listeners: number): number => clamp(2 + 6 * Math.log(1 + listeners), 6, 60);

/** Maximum movement of the room pull per second, per axis. */
export const roomSlewPerSec = (listeners: number): number => Math.max(0.025, 0.12 / Math.sqrt(Math.max(1, listeners)));
