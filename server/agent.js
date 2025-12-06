import { generateDslOperations } from './claude.js';
import { StyleMemory } from './memory.js';
import { DslManager } from './dsl/index.js';

export class MusicAgent {
  constructor(io, state, queueProcessor) {
    this.io = io;
    this.state = state;
    this.queueProcessor = queueProcessor;
    this.styleMemory = new StyleMemory();
    this.dsl = new DslManager(state.tempo.bpm);
    this.isRunning = false;
    this.generationInterval = null;
    this.lastMajorChange = Date.now();

    // Configuration
    this.GENERATION_INTERVAL = 20000; // 20 seconds
    this.MAJOR_CHANGE_FEEDBACK_THRESHOLD = 2;
  }

  async start() {
    if (this.isRunning) {
      console.log('Agent already running');
      return;
    }

    console.log('🤖 Starting music agent...');
    this.isRunning = true;

    // Generate initial layers if empty
    if (this.dsl.getLayerNames().length === 0) {
      console.log('📝 Generating initial layers...');
      await this.performUpdate('initial');
    }

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

    const recentFeedback = this.getRecentFeedback();
    const feedbackSinceLastChange = recentFeedback.filter(
      f => f.timestamp > this.lastMajorChange
    );

    if (this.shouldTriggerUpdate(feedbackSinceLastChange)) {
      console.log('🎯 Update triggered by feedback');
      await this.performUpdate('feedback');
      this.lastMajorChange = Date.now();
    }
  }

  shouldTriggerUpdate(recentFeedback) {
    if (recentFeedback.length < this.MAJOR_CHANGE_FEEDBACK_THRESHOLD) {
      return false;
    }

    const likes = recentFeedback.filter(f => f.type === 'like').length;
    const dislikes = recentFeedback.filter(f => f.type === 'dislike').length;
    const suggestions = recentFeedback.filter(f => f.type === 'suggestion').length;

    return dislikes > likes || suggestions >= 2;
  }

  async performUpdate(updateType = 'periodic') {
    if (!this.isRunning && updateType !== 'initial') return;

    console.log(`🎵 Generating DSL operations (${updateType})...`);

    try {
      const context = {
        layers: this.dsl.getState().state,
        currentBar: this.dsl.getCurrentBar(),
        tempo: this.state.tempo,
        hasAutomations: this.dsl.hasActiveAutomations(),
      };

      const recentFeedback = this.getRecentFeedback(10);
      const styleSummary = this.styleMemory.getSummary();

      const { operations, intent } = await generateDslOperations(context, recentFeedback, styleSummary);

      if (operations && operations.length > 0) {
        const result = this.dsl.applyOperations(operations);

        if (result.ok && result.compiled) {
          console.log(`✨ Applied ${operations.length} operations`);
          if (intent) console.log(`💭 Intent: "${intent}"`);
          this.emitPatternUpdate(result.compiled, intent);
        } else if (result.errors.length > 0) {
          console.warn('DSL operation errors:', result.errors);
        }
      }
    } catch (error) {
      console.error('Error generating DSL operations:', error);
    }
  }

  /**
   * Called by queueProcessor on each bar tick
   */
  tick(bar) {
    const result = this.dsl.tick(bar);

    if (result.compiled) {
      this.emitPatternUpdate(result.compiled);
    }

    return result;
  }

  emitPatternUpdate(compiled, intent = null) {
    const layerState = this.dsl.getState().state;

    // Update state for feedback attribution
    this.state.currentPattern = {
      id: `dsl-${Date.now()}`,
      pattern: compiled,
      bars: 4,
      startedAt: Date.now(),
      endsAt: Date.now() + (4 * this.state.tempo.barDuration),
    };

    // Send layer state to clients
    this.io.emit('layer-update', {
      layerState: {
        layers: layerState.layers,
        layerOrder: layerState.layerOrder,
        bpm: this.state.tempo.bpm,
        solo: layerState.solo,
        scenes: layerState.scenes,
        currentScene: layerState.currentScene,
        sceneCount: layerState.sceneCount,
      },
      compiled,
      intent, // Artistic commentary
      timestamp: Date.now(),
    });
  }

  getRecentFeedback(count = 10) {
    return this.state.feedback.slice(-count);
  }

  getStyleSummary() {
    return this.styleMemory.getSummary();
  }

  exportStyleProfile() {
    return this.styleMemory.exportProfile();
  }

  getDslState() {
    return this.dsl.getState();
  }

  getLastPattern() {
    return this.dsl.getLastPattern();
  }
}
