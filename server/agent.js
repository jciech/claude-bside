import { generatePattern } from './claude.js';
import { StyleMemory } from './memory.js';

export class MusicAgent {
  constructor(io, state) {
    this.io = io;
    this.state = state;
    this.styleMemory = new StyleMemory();
    this.isRunning = false;
    this.microVariationInterval = null;
    this.lastMajorChange = Date.now();

    // Configuration
    this.MICRO_VARIATION_INTERVAL = 15000; // 15 seconds (faster iterations!)
    this.MAJOR_CHANGE_FEEDBACK_THRESHOLD = 2; // 2 pieces of feedback triggers consideration (more responsive!)
  }

  /**
   * Start the agentic loop
   */
  start() {
    if (this.isRunning) {
      console.log('Agent already running');
      return;
    }

    console.log('🤖 Starting music agent...');
    this.isRunning = true;

    // Schedule micro-variations
    this.microVariationInterval = setInterval(() => {
      this.performMicroVariation();
    }, this.MICRO_VARIATION_INTERVAL);

    console.log(`✅ Agent started (micro-variations every ${this.MICRO_VARIATION_INTERVAL/1000}s)`);
  }

  /**
   * Stop the agentic loop
   */
  stop() {
    if (this.microVariationInterval) {
      clearInterval(this.microVariationInterval);
      this.microVariationInterval = null;
    }

    this.isRunning = false;
    console.log('🛑 Agent stopped');
  }

  /**
   * Process feedback and decide whether to make a major change
   */
  async processFeedback(feedback) {
    // Update style memory
    this.styleMemory.processFeedback(feedback, this.state.currentPattern);

    // Check if we should make a major change
    const recentFeedback = this.getRecentFeedback();
    const feedbackSinceLastChange = recentFeedback.filter(
      f => f.timestamp > this.lastMajorChange
    );

    const shouldMakeMajorChange = this.shouldMakeMajorChange(feedbackSinceLastChange);

    if (shouldMakeMajorChange) {
      console.log('🎯 Major change triggered by feedback');
      await this.performMajorChange();
    }
  }

  /**
   * Determine if major change is warranted
   */
  shouldMakeMajorChange(recentFeedback) {
    if (recentFeedback.length < this.MAJOR_CHANGE_FEEDBACK_THRESHOLD) {
      return false;
    }

    const likes = recentFeedback.filter(f => f.type === 'like').length;
    const dislikes = recentFeedback.filter(f => f.type === 'dislike').length;
    const suggestions = recentFeedback.filter(f => f.type === 'suggestion').length;

    // Make major change if:
    // - More dislikes than likes
    // - Or we have explicit suggestions
    return dislikes > likes || suggestions >= 2;
  }

  /**
   * Perform a micro-variation
   */
  async performMicroVariation() {
    if (!this.isRunning) return;

    console.log('🎵 Generating micro-variation...');

    try {
      const context = {
        currentPattern: this.state.currentPattern,
        iterationType: 'micro-variation'
      };

      const recentFeedback = this.getRecentFeedback(5);
      const styleSummary = this.styleMemory.getSummary();

      const newPattern = await generatePattern(context, recentFeedback, styleSummary);

      this.updatePattern(newPattern, 'micro-variation');
    } catch (error) {
      console.error('Error generating micro-variation:', error);
    }
  }

  /**
   * Perform a major change
   */
  async performMajorChange() {
    console.log('🚀 Generating major change...');

    try {
      const context = {
        currentPattern: this.state.currentPattern,
        iterationType: 'major-change'
      };

      const recentFeedback = this.getRecentFeedback(10);
      const styleSummary = this.styleMemory.getSummary();

      const newPattern = await generatePattern(context, recentFeedback, styleSummary);

      this.updatePattern(newPattern, 'major-change');
      this.lastMajorChange = Date.now();
    } catch (error) {
      console.error('Error generating major change:', error);
    }
  }

  /**
   * Update pattern and broadcast to clients
   */
  updatePattern(newPattern, changeType) {
    this.state.currentPattern = newPattern;

    console.log(`✨ New pattern (${changeType}):`, newPattern.slice(0, 80) + '...');

    // Broadcast to all clients
    this.io.emit('pattern-update', {
      pattern: newPattern,
      changeType,
      timestamp: Date.now()
    });
  }

  /**
   * Get recent feedback
   */
  getRecentFeedback(count = 10) {
    return this.state.feedback.slice(-count);
  }

  /**
   * Get style memory summary
   */
  getStyleSummary() {
    return this.styleMemory.getSummary();
  }

  /**
   * Export style profile
   */
  exportStyleProfile() {
    return this.styleMemory.exportProfile();
  }
}
