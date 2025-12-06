/**
 * AudioManager - Handles Strudel audio playback
 *
 * Key insight: We use setPattern() instead of evaluate() for smooth transitions.
 * The REPL starts once and we swap patterns at bar boundaries.
 */
export class AudioManager {
  constructor() {
    this.isInitialized = false;
    this.isPlaying = false;
    this.currentLayers = new Map(); // layer name -> pattern object
    this.editorElement = null;
    this.editor = null;
    this.repl = null;
  }

  async initialize() {
    if (this.isInitialized) {
      return true;
    }

    try {
      this.editorElement = document.getElementById('strudel-engine');

      if (!this.editorElement) {
        throw new Error('strudel-engine element not found');
      }

      await this.waitForEditor();
      this.isInitialized = true;

      return true;
    } catch (error) {
      console.error('Failed to initialize audio:', error);
      throw error;
    }
  }

  async waitForEditor() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50;

      const check = async () => {
        if (this.editorElement.editor) {
          this.editor = this.editorElement.editor;
          this.repl = this.editor.repl;

          if (this.editor.prebaked) {
            try {
              await this.editor.prebaked;
            } catch (err) {
              this.editor.prebaked = Promise.resolve();
            }
          }

          try {
            await this.loadCustomSamples();
          } catch (err) {
            console.warn('Custom samples failed to load:', err.message);
          }

          resolve();
        } else if (attempts++ < maxAttempts) {
          setTimeout(check, 100);
        } else {
          reject(new Error('Strudel editor failed to load'));
        }
      };

      check();
    });
  }

  async loadCustomSamples() {
    // Wait for Strudel to fully initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      console.log('Loading samples via evaluate...');

      // Load samples through evaluate to ensure they're in Strudel's context
      await this.editor.setCode(`
        await samples('github:tidalcycles/dirt-samples');
        await samples('github:switchangel/breaks');
        await samples('github:switchangel/pad');
        silence
      `);
      await this.editor.evaluate();

      console.log('All sample banks loaded');
    } catch (err) {
      console.warn('Samples failed to load:', err.message);

      // Fallback: try window.samples directly
      try {
        if (typeof window.samples === 'function') {
          console.log('Trying fallback sample loading...');
          await window.samples('github:tidalcycles/dirt-samples');
          await window.samples('github:switchangel/breaks');
          await window.samples('github:switchangel/pad');
          console.log('Fallback sample loading succeeded');
        }
      } catch (e) {
        console.warn('Fallback also failed:', e.message);
      }
    }
  }

  /**
   * Update layers from server state
   * Uses evaluate to set pattern - Strudel handles transitions
   */
  async updateLayers(layerState) {
    if (!this.isInitialized || !this.editor) {
      throw new Error('AudioManager not initialized');
    }

    try {
      // Build and evaluate pattern from layer state
      const success = await this.buildPatternFromState(layerState);

      if (!success) {
        // No active layers - evaluate silence
        await this.editor.evaluate('silence');
        return { success: true, layerCount: 0 };
      }

      // evaluate() should auto-start, but ensure we track state
      this.isPlaying = true;
      await this.ensureAudioContext();

      return { success: true, layerCount: layerState.layerOrder?.length || 0 };
    } catch (error) {
      console.error('Error updating layers:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Build a Strudel Pattern object from layer state
   * We build a code string and evaluate it once (more reliable than parsing individually)
   */
  async buildPatternFromState(layerState) {
    const { layers, layerOrder, bpm, solo } = layerState;

    if (!layers || !layerOrder || layerOrder.length === 0) {
      return null;
    }

    const soloSet = solo ? new Set(solo) : null;
    const cps = bpm / 60;

    // Helper to format values (numbers vs pattern strings)
    const fmt = (val) => typeof val === 'number' ? val.toFixed(2) : val;

    // Build code strings for each active layer
    const layerCodes = [];

    for (const name of layerOrder) {
      const layer = layers[name];
      if (!layer) continue;
      if (layer.muted) continue;
      if (soloSet && !soloSet.has(name)) continue;

      let code = layer.pattern;

      // Apply gain (layer.gain could be a number or pattern string)
      if (layer.gain !== undefined && layer.gain !== null) {
        if (typeof layer.gain === 'number' && Math.abs(layer.gain - 1.0) > 0.001) {
          code = `(${code}).gain(${fmt(layer.gain)})`;
        } else if (typeof layer.gain === 'string') {
          code = `(${code}).gain(${layer.gain})`;
        }
      }

      // Apply effects (values could be numbers or pattern strings)
      const effects = layer.effects || {};
      if (effects.lpf !== null && effects.lpf !== undefined) {
        code = `(${code}).lpf(${fmt(effects.lpf)})`;
      }
      if (effects.hpf !== null && effects.hpf !== undefined) {
        code = `(${code}).hpf(${fmt(effects.hpf)})`;
      }
      if (effects.room !== null && effects.room !== undefined) {
        code = `(${code}).room(${fmt(effects.room)})`;
      }
      if (effects.delay !== null && effects.delay !== undefined) {
        code = `(${code}).delay(${fmt(effects.delay)})`;
      }
      if (effects.pan !== null && effects.pan !== undefined) {
        // Clamp pan to valid range [0, 1]
        let panVal = effects.pan;
        if (typeof panVal === 'number') {
          panVal = Math.max(0, Math.min(1, panVal));
        }
        code = `(${code}).pan(${fmt(panVal)})`;
      }

      layerCodes.push(code);
    }

    if (layerCodes.length === 0) {
      return null;
    }

    // Build full pattern code with global tempo
    const fullCode = layerCodes.length === 1
      ? `setcps(${cps.toFixed(2)}); ${layerCodes[0]}`
      : `setcps(${cps.toFixed(2)}); stack(\n  ${layerCodes.join(',\n  ')}\n)`;

    console.log('=== EVALUATING PATTERN ===');
    console.log(fullCode);
    console.log('=== END PATTERN ===');

    try {
      // Set code in editor and evaluate
      this.editor.setCode(fullCode);
      await this.editor.evaluate(fullCode);

      // Ensure scheduler is running
      if (this.repl && !this.repl.started) {
        this.repl.start();
      }

      return true;
    } catch (err) {
      console.error('Failed to build pattern:', err);
      return null;
    }
  }

  /**
   * Parse a pattern string into a Pattern object
   * Uses the editor's evaluate for proper Strudel context
   */
  async parsePatternAsync(patternString) {
    try {
      // Use the editor's evaluate which has proper Strudel context
      const result = await this.editor.evaluate(patternString);
      return result?.pattern || result;
    } catch (err) {
      console.error('Failed to parse pattern:', patternString, err);
      return null;
    }
  }

  /**
   * Synchronous pattern parse - uses indirect eval
   * Falls back for when async isn't possible
   */
  parsePattern(patternString) {
    try {
      const result = (0, eval)(patternString);
      return result;
    } catch (err) {
      console.error('Failed to parse pattern:', patternString, err);
      return null;
    }
  }

  async ensureAudioContext() {
    try {
      const ctx = this.repl?.audioContext;
      if (ctx && ctx.state === 'suspended') {
        await ctx.resume();
      }
    } catch (err) {
      console.warn('Could not resume audio context:', err);
    }
  }

  /**
   * Play a compiled pattern with BPM (v2 method)
   */
  async playCompiledPattern(compiled, bpm = 120) {
    if (!this.isInitialized || !this.editor) {
      throw new Error('AudioManager not initialized');
    }

    try {
      const cps = bpm / 60;
      const fullCode = `setcps(${cps.toFixed(2)}); ${compiled}`;

      this.editor.setCode(fullCode);
      await this.editor.evaluate(fullCode);

      if (this.repl && !this.repl.started) {
        this.repl.start();
      }

      this.isPlaying = true;
      await this.ensureAudioContext();

      return { success: true };
    } catch (error) {
      console.error('Error playing compiled pattern:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Legacy method - plays a complete pattern string (uses evaluate, may cause glitches)
   */
  async playPattern(code) {
    if (!this.isInitialized || !this.editor) {
      throw new Error('AudioManager not initialized');
    }

    try {
      this.editor.code = code;
      this.editor.setCode(code);
      await this.editor.evaluate();

      if (!this.isPlaying) {
        this.repl.start();
        this.isPlaying = true;
      }

      await this.ensureAudioContext();

      return { success: true, pattern: code };
    } catch (error) {
      console.error('Error playing pattern:', error);
      return { success: false, error: error.message };
    }
  }

  stop() {
    if (this.isPlaying && this.repl) {
      this.repl.stop();
      this.isPlaying = false;
    }
  }

  pause() {
    if (this.repl?.pause) {
      this.repl.pause();
      this.isPlaying = false;
    }
  }

  resume() {
    if (!this.isPlaying && this.repl) {
      this.repl.start();
      this.isPlaying = true;
    }
  }

  getState() {
    return {
      isInitialized: this.isInitialized,
      isPlaying: this.isPlaying,
      layerCount: this.currentLayers.size,
    };
  }
}
