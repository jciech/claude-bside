/**
 * DSL v2 - Voice State Management
 *
 * Core concepts:
 * - Voice: A named pattern + level (0-1)
 * - Pattern: Strudel code string (all effects embedded)
 * - Level: Presence/prominence (0 = silent, 1 = full)
 * - Transitions: Level changes interpolate over N bars
 */

/**
 * Attempt to fix common pattern syntax errors
 */
function fixPatternSyntax(pattern) {
  if (!pattern || typeof pattern !== 'string') return pattern;

  let fixed = pattern;

  // Fix unquoted note/s/n arguments: note(<c2 eb2>) -> note("<c2 eb2>")
  fixed = fixed.replace(/\b(note|n|s)\((<[^>]+>)\)/g, '$1("$2")');

  // Fix unquoted note arguments without angle brackets: note(c2 eb2) -> note("c2 eb2")
  fixed = fixed.replace(/\b(note|n)\(([a-g][b#]?\d[^)]*)\)/gi, '$1("$2")');

  // Fix pipes in mini-notation: "<a|b>" -> "<a b>"
  fixed = fixed.replace(/<([^>]*)\|([^>]*)>/g, (match) => {
    return match.replace(/\|/g, ' ');
  });

  if (fixed !== pattern) {
    console.log('🔧 Fixed pattern syntax:', pattern.substring(0, 50), '->', fixed.substring(0, 50));
  }

  return fixed;
}

export class Voice {
  constructor(name, pattern, level = 1.0) {
    this.name = name;
    this.pattern = fixPatternSyntax(pattern);
    this.level = level;
    this.targetLevel = level;
    this.transitionBars = 0;
    this.transitionStartBar = 0;
    this.transitionStartLevel = level;
  }

  /**
   * Set a target level to transition to
   */
  setTarget(targetLevel, bars, currentBar) {
    this.targetLevel = Math.max(0, Math.min(1, targetLevel));
    this.transitionBars = bars;
    this.transitionStartBar = currentBar;
    this.transitionStartLevel = this.level;
  }

  /**
   * Update level based on current bar (interpolation)
   */
  tick(currentBar) {
    if (this.transitionBars === 0 || this.level === this.targetLevel) {
      return false; // No change
    }

    const elapsed = currentBar - this.transitionStartBar;
    if (elapsed >= this.transitionBars) {
      // Transition complete
      this.level = this.targetLevel;
      this.transitionBars = 0;
      return true;
    }

    // Interpolate
    const progress = elapsed / this.transitionBars;
    this.level = this.transitionStartLevel +
      (this.targetLevel - this.transitionStartLevel) * progress;
    return true;
  }

  /**
   * Check if voice is audible
   */
  isAudible() {
    return this.level > 0.001;
  }

  /**
   * Check if transitioning
   */
  isTransitioning() {
    return this.transitionBars > 0 && this.level !== this.targetLevel;
  }

  clone() {
    const v = new Voice(this.name, this.pattern, this.level);
    v.targetLevel = this.targetLevel;
    v.transitionBars = this.transitionBars;
    v.transitionStartBar = this.transitionStartBar;
    v.transitionStartLevel = this.transitionStartLevel;
    return v;
  }

  toJSON() {
    return {
      pattern: this.pattern,
      level: Math.round(this.level * 100) / 100,
      target: this.targetLevel !== this.level ? this.targetLevel : undefined,
      transitioning: this.isTransitioning() || undefined,
    };
  }
}

export class MusicState {
  constructor(bpm = 120) {
    this.voices = new Map();
    this.bpm = bpm;
    this.currentBar = 0;
    this.energyBudget = 1.5; // Higher budget = more room before warnings
  }

  /**
   * Apply a target state - the core operation
   * @param {Object} target - Map of voice name to { pattern?, level? }
   * @param {number} overBars - Bars to transition levels
   */
  applyTarget(target, overBars = 4) {
    for (const [name, spec] of Object.entries(target)) {
      // Normalize spec - can be just a number (level) or an object
      let pattern, level;
      if (typeof spec === 'number') {
        level = spec;
        pattern = undefined;
      } else {
        pattern = spec.pattern || spec.p;
        level = spec.level ?? spec.l ?? undefined;
      }

      const existing = this.voices.get(name);

      if (existing) {
        // Update existing voice
        if (pattern !== undefined) {
          existing.pattern = fixPatternSyntax(pattern);
        }
        if (level !== undefined) {
          existing.setTarget(level, overBars, this.currentBar);
        }
      } else if (pattern !== undefined) {
        // Create new voice (must have pattern)
        const voice = new Voice(name, pattern, 0); // Start at 0
        voice.setTarget(level ?? 1.0, overBars, this.currentBar); // Fade in
        this.voices.set(name, voice);
      }
      // If no pattern and voice doesn't exist, ignore
    }
  }

  /**
   * Set BPM
   */
  setBpm(bpm) {
    this.bpm = Math.max(40, Math.min(200, bpm));
  }

  /**
   * Process a bar tick - update all voice levels
   */
  tick(bar) {
    this.currentBar = bar;
    let changed = false;

    for (const voice of this.voices.values()) {
      if (voice.tick(bar)) {
        changed = true;
      }
    }

    // Don't auto-delete silent voices - let Claude manage them
    // This allows voices to be "muted" (level 0) and brought back later

    return changed;
  }

  /**
   * Get audible voices in order
   */
  getAudibleVoices() {
    return Array.from(this.voices.values()).filter(v => v.isAudible());
  }

  /**
   * Calculate energy based on active voices
   */
  calculateEnergy() {
    let total = 0;
    for (const voice of this.voices.values()) {
      if (!voice.isAudible()) continue;

      let energy = voice.level;
      const p = voice.pattern.toLowerCase();

      // Weight by pattern type
      if (p.includes('bd') || p.includes('kick')) energy *= 1.3;
      if (p.includes('sd') || p.includes('sn') || p.includes('cp')) energy *= 1.2;
      if (p.includes('breaks')) energy *= 1.4;
      if (p.includes('swpad') || p.includes('pad')) energy *= 0.6;
      if (p.match(/\*\d{2}/)) energy *= 1.2;
      if (p.includes('.slow(')) energy *= 0.8;

      total += energy;
    }
    return total;
  }

  getEnergyStatus() {
    const current = this.calculateEnergy();
    const budget = this.energyBudget;
    const usage = budget > 0 ? current / budget : 0;

    let status;
    if (usage < 0.3) status = 'sparse';
    else if (usage < 0.6) status = 'minimal';
    else if (usage < 0.85) status = 'balanced';
    else if (usage < 1.0) status = 'full';
    else if (usage < 1.3) status = 'dense';
    else status = 'overloaded';

    return {
      current: Math.round(current * 100) / 100,
      budget,
      usage: Math.round(usage * 100) / 100,
      status,
    };
  }

  /**
   * Check if any transitions are active
   */
  hasActiveTransitions() {
    for (const voice of this.voices.values()) {
      if (voice.isTransitioning()) return true;
    }
    return false;
  }

  toJSON() {
    const voices = {};
    for (const [name, voice] of this.voices) {
      voices[name] = voice.toJSON();
    }

    return {
      voices,
      voiceCount: this.voices.size,
      bpm: this.bpm,
      currentBar: this.currentBar,
      energy: this.getEnergyStatus(),
      transitioning: this.hasActiveTransitions(),
    };
  }
}
