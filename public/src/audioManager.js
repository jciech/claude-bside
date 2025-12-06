export class AudioManager {
  constructor() {
    this.isInitialized = false;
    this.isPlaying = false;
    this.currentPattern = null;
    this.lastValidPattern = null; // Fallback for when new patterns fail
    this.editorElement = null;
    this.editor = null;
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
    if (typeof window.samples === 'function') {
      await window.samples('github:switchangel/breaks');
      await window.samples('github:switchangel/pad');
      return;
    }

    console.warn('window.samples not available yet');
  }

  async playPattern(code) {
    if (!this.isInitialized || !this.editor) {
      throw new Error('AudioManager not initialized. Call initialize() first.');
    }

    if (typeof code !== 'string') {
      throw new Error(`Pattern must be a string, got ${typeof code}`);
    }

    try {
      if (this.isPlaying) {
        this.editor.repl.stop();
      }

      this.editor.code = code;
      this.editor.setCode(code);
      await this.editor.evaluate();
      this.editor.repl.start();
      this.isPlaying = true;

      try {
        const ctx = this.editor.repl.audioContext;
        if (ctx && ctx.state === 'suspended') {
          await ctx.resume();
        }
      } catch (err) {}

      this.currentPattern = code;
      this.lastValidPattern = code; // Remember this worked
      return { success: true, pattern: code };
    } catch (error) {
      console.error('Error playing pattern:', error);

      // Try to recover with last valid pattern
      if (this.lastValidPattern && this.lastValidPattern !== code) {
        console.warn('Falling back to last valid pattern');
        try {
          this.editor.code = this.lastValidPattern;
          this.editor.setCode(this.lastValidPattern);
          await this.editor.evaluate();
          this.editor.repl.start();
          this.isPlaying = true;
          this.currentPattern = this.lastValidPattern;
          return { success: false, pattern: this.lastValidPattern, fallback: true, error: error.message };
        } catch (fallbackError) {
          console.error('Fallback also failed:', fallbackError);
        }
      }

      throw error;
    }
  }

  stop() {
    if (this.isPlaying && this.editor?.repl) {
      this.editor.repl.stop();
      this.isPlaying = false;
    }
  }

  pause() {
    if (this.editor?.repl?.pause) {
      this.editor.repl.pause();
      this.isPlaying = false;
    }
  }

  resume() {
    if (!this.isPlaying && this.editor?.repl) {
      this.editor.repl.start();
      this.isPlaying = true;
    }
  }

  getState() {
    return {
      isInitialized: this.isInitialized,
      isPlaying: this.isPlaying,
      hasPattern: this.currentPattern !== null,
    };
  }
}
