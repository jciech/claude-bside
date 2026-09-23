import { generateTarget } from './claude2.js';
import { MusicManager } from './dsl2/index.js';
import { StyleMemory } from './memory.js';

export class MusicAgent {
  constructor(io, state) {
    this.io = io;
    this.state = state;
    this.music = new MusicManager(state.tempo.bpm);
    this.styleMemory = new StyleMemory();
    this.isRunning = false;
    this.generationInterval = null;
    this.lastUpdate = Date.now();

    // Configuration
    this.GENERATION_INTERVAL = 20000; // 20 seconds
  }

  async start() {
    if (this.isRunning) {
      console.log('Agent already running');
      return;
    }

    console.log('🤖 Starting music agent v2...');
    this.isRunning = true;

    // Generate initial music
    await this.performUpdate('initial');

    // Schedule periodic updates
    this.generationInterval = setInterval(() => {
      this.performUpdate('periodic');
    }, this.GENERATION_INTERVAL);

    console.log(`✅ Agent started (updating every ${this.GENERATION_INTERVAL / 1000}s)`);
  }

  stop() {
    if (this.generationInterval) {
      clearInterval(this.generationInterval);
      this.generationInterval = null;
    }

    this.isRunning = false;
    console.log('🛑 Agent stopped');
  }

  async processFeedback(feedback) {
    this.styleMemory.processFeedback(feedback);

    // Check if we should trigger an update based on feedback
    const recentFeedback = this.getRecentFeedback();
    const negatives = recentFeedback.filter(f =>
      f.type === 'dislike' && f.timestamp > this.lastUpdate
    ).length;

    if (negatives >= 2) {
      console.log('🎯 Update triggered by negative feedback');
      await this.performUpdate('feedback');
    }
  }

  async performUpdate(updateType = 'periodic') {
    if (!this.isRunning && updateType !== 'initial') return;

    console.log(`🎵 Generating music (${updateType})...`);

    try {
      const context = {
        state: this.music.getState(),
        bar: this.music.state.currentBar,
      };

      const recentFeedback = this.getRecentFeedback(10);
      const styleSummary = this.styleMemory.getSummary();

      // Get target from Claude
      const response = await generateTarget(context, recentFeedback, styleSummary);

      if (response.target) {
        // Apply the target
        const result = this.music.applyResponse(response);

        if (result.ok && result.compiled) {
          console.log(`✨ Applied target state`);
          if (response.intent) console.log(`💭 Intent: "${response.intent}"`);

          this.emitUpdate(result.compiled, result.state, response.intent);
          this.lastUpdate = Date.now();
        }
      }
    } catch (error) {
      console.error('Error generating music:', error);
    }
  }

  /**
   * Called by queue processor on each bar tick
   */
  tick(bar) {
    const result = this.music.tick(bar);

    if (result.changed) {
      this.emitUpdate(result.compiled, result.state, null);
    }

    return result;
  }

  emitUpdate(compiled, musicState, intent) {
    console.log('📤 Emitting music-update:', compiled.substring(0, 100) + '...');

    // Update state for feedback attribution
    this.state.currentPattern = {
      id: `v2-${Date.now()}`,
      pattern: compiled,
      bars: 4,
      startedAt: Date.now(),
      endsAt: Date.now() + (4 * this.state.tempo.barDuration),
    };

    // Emit to clients
    this.io.emit('music-update', {
      compiled,
      state: musicState,
      bpm: this.music.getBpm(),
      intent,
      timestamp: Date.now(),
    });
  }

  getRecentFeedback(count = 10) {
    return this.state.feedback.slice(-count);
  }

  getStyleSummary() {
    return this.styleMemory.getSummary();
  }

  getMusicState() {
    return this.music.getState();
  }

  getCompiled() {
    return this.music.getCompiled();
  }
}
