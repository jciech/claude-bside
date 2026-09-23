/**
 * DSL v2 - Music Manager
 *
 * Manages the music state and handles updates from Claude.
 */

import { MusicState } from './state.js';
import { compile } from './compiler.js';

export class MusicManager {
  constructor(bpm = 120) {
    this.state = new MusicState(bpm);
    this.lastCompiled = null;
  }

  /**
   * Apply a target from Claude
   * @param {Object} response - Claude's response { target, over, bpm, intent }
   */
  applyResponse(response) {
    const { target, over = 4, bpm } = response;

    // Update BPM if specified
    if (bpm !== undefined) {
      this.state.setBpm(bpm);
    }

    // Apply target state
    if (target && typeof target === 'object') {
      this.state.applyTarget(target, over);
    }

    // Compile and return
    const compiled = compile(this.state);
    this.lastCompiled = compiled;

    return {
      ok: true,
      compiled,
      state: this.state.toJSON(),
    };
  }

  /**
   * Process a bar tick
   */
  tick(bar) {
    const changed = this.state.tick(bar);

    if (changed) {
      const compiled = compile(this.state);
      this.lastCompiled = compiled;
      return { changed: true, compiled, state: this.state.toJSON() };
    }

    return { changed: false };
  }

  /**
   * Get current state
   */
  getState() {
    return this.state.toJSON();
  }

  /**
   * Get last compiled pattern
   */
  getCompiled() {
    return this.lastCompiled || compile(this.state);
  }

  /**
   * Get BPM
   */
  getBpm() {
    return this.state.bpm;
  }
}

export { MusicState } from './state.js';
export { compile } from './compiler.js';
