/**
 * EvolveDSL Manager
 * Main interface for the layer-based music evolution system
 */

import { LayerState } from './state.js';
import { executeOperation, executeOperations } from './operations.js';
import { compileToStrudel } from './compiler.js';
import { processTick } from './automations.js';

export class DslManager {
  constructor(bpm = 120) {
    this.state = new LayerState(bpm);
    this.lastCompiledPattern = null;
  }

  /**
   * Apply a list of operations from Claude
   * @param {Array} operations - Array of operation objects
   * @returns {Object} Result with compiled pattern and any errors
   */
  applyOperations(operations) {
    const results = executeOperations(this.state, operations);
    const errors = results.filter(r => !r.success).map(r => r.error);
    const anyFailed = errors.length > 0;

    const compiled = compileToStrudel(this.state);
    this.lastCompiledPattern = compiled;

    return {
      ok: !anyFailed,
      compiled,
      errors,
      state: this.state.toJSON(),
    };
  }

  /**
   * Process a bar tick - advances automations
   * @param {number} bar - Current bar number
   * @returns {Object} Result with compiled pattern if state changed
   */
  tick(bar) {
    const result = processTick(this.state, bar);

    let compiled = null;
    if (result.stateChanged || result.completedAutomations > 0) {
      compiled = compileToStrudel(this.state);
      this.lastCompiledPattern = compiled;
    }

    return {
      ok: true,
      compiled,
      stateChanged: result.stateChanged,
      completedAutomations: result.completedAutomations,
    };
  }

  /**
   * Force recompile and return current pattern
   * @returns {Object} Result with compiled pattern
   */
  compile() {
    const compiled = compileToStrudel(this.state);
    this.lastCompiledPattern = compiled;

    return {
      ok: true,
      compiled,
    };
  }

  /**
   * Get current state as JSON
   * @returns {Object} Current layer state
   */
  getState() {
    return {
      ok: true,
      state: this.state.toJSON(),
    };
  }

  /**
   * Set BPM
   * @param {number} bpm - Beats per minute
   */
  setBpm(bpm) {
    this.state.bpm = bpm;
    return { ok: true };
  }

  /**
   * Reset all state
   */
  reset() {
    this.state.reset();
    this.lastCompiledPattern = null;
    return { ok: true };
  }

  /**
   * Get the last compiled pattern (useful for fallback)
   * @returns {string|null} Last compiled Strudel pattern
   */
  getLastPattern() {
    return this.lastCompiledPattern;
  }

  /**
   * Get layer names
   * @returns {Array} List of layer names
   */
  getLayerNames() {
    return this.state.layerOrder;
  }

  /**
   * Check if any automations are active
   * @returns {boolean} True if automations are running
   */
  hasActiveAutomations() {
    return this.state.automations.length > 0;
  }

  /**
   * Get current bar
   * @returns {number} Current bar number
   */
  getCurrentBar() {
    return this.state.currentBar;
  }
}

// Re-export for convenience
export { LayerState } from './state.js';
export { compileToStrudel } from './compiler.js';
export { executeOperation, executeOperations } from './operations.js';
export { processTick } from './automations.js';
