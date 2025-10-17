export class AudioManager {
  constructor() {
    this.isInitialized = false;
    this.isPlaying = false;
    this.currentPattern = null;
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

          // Wait for prebake, replace if it fails (404 on uzu-drumkit.json)
          if (this.editor.prebaked) {
            try {
              await this.editor.prebaked;
            } catch (err) {
              this.editor.prebaked = Promise.resolve();
            }
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

  async playPattern(code) {
    if (!this.isInitialized || !this.editor) {
      throw new Error('AudioManager not initialized. Call initialize() first.');
    }

    try {
      if (this.isPlaying) {
        this.editor.repl.stop();
      }

      this.editor.code = code;
      this.editor.setCode(code);
      await new Promise(resolve => setTimeout(resolve, 50));

      try {
        await this.editor.evaluate();
      } catch (err) {
        // Ignore prebake errors
      }

      this.editor.repl.start();
      this.isPlaying = true;

      // Resume AudioContext if browser suspended it
      try {
        const { getAudioContext } = await import('@strudel/webaudio');
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();
      } catch (err) {}

      this.currentPattern = code;
      return true;
    } catch (error) {
      console.error('❌ Error playing pattern:', error);
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
