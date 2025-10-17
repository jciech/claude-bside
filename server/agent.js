import { generateQueueOperations } from './claude.js';
import { StyleMemory } from './memory.js';
import { randomUUID } from 'crypto';

export class MusicAgent {
  constructor(io, state, queueProcessor) {
    this.io = io;
    this.state = state;
    this.queueProcessor = queueProcessor;
    this.styleMemory = new StyleMemory();
    this.isRunning = false;
    this.generationInterval = null;
    this.lastMajorChange = Date.now();

    // Configuration
    this.GENERATION_INTERVAL = 20000; // 20 seconds - check queue and generate if needed
    this.MAJOR_CHANGE_FEEDBACK_THRESHOLD = 2;
    this.MIN_QUEUE_LENGTH = 3; // Minimum patterns to maintain
    this.TARGET_QUEUE_LENGTH = 5; // Target queue length
  }

  /**
   * Start the agentic loop
   */
  async start() {
    if (this.isRunning) {
      console.log('Agent already running');
      return;
    }

    console.log('🤖 Starting music agent...');
    this.isRunning = true;

    // Generate initial queue if empty
    if (this.state.patternQueue.length === 0) {
      console.log('📝 Generating initial queue...');
      await this.performQueueUpdate('initial');
    }

    // Schedule queue updates
    this.generationInterval = setInterval(() => {
      this.performQueueUpdate('periodic');
    }, this.GENERATION_INTERVAL);

    console.log(`✅ Agent started (checking queue every ${this.GENERATION_INTERVAL/1000}s)`);
  }

  /**
   * Stop the agentic loop
   */
  stop() {
    if (this.generationInterval) {
      clearInterval(this.generationInterval);
      this.generationInterval = null;
    }

    this.isRunning = false;
    console.log('🛑 Agent stopped');
  }

  /**
   * Process feedback and potentially update the queue
   */
  async processFeedback(feedback) {
    // Update style memory
    this.styleMemory.processFeedback(feedback, this.state.currentPattern.pattern);

    // Check if we should regenerate based on feedback
    const recentFeedback = this.getRecentFeedback();
    const feedbackSinceLastChange = recentFeedback.filter(
      f => f.timestamp > this.lastMajorChange
    );

    const shouldRegenerateQueue = this.shouldRegenerateQueue(feedbackSinceLastChange);

    if (shouldRegenerateQueue) {
      console.log('🎯 Queue regeneration triggered by feedback');
      // Clear queue and regenerate
      this.clearQueue();
      await this.performQueueUpdate('feedback');
      this.lastMajorChange = Date.now();
    }
  }

  /**
   * Determine if queue should be regenerated based on feedback
   */
  shouldRegenerateQueue(recentFeedback) {
    if (recentFeedback.length < this.MAJOR_CHANGE_FEEDBACK_THRESHOLD) {
      return false;
    }

    const likes = recentFeedback.filter(f => f.type === 'like').length;
    const dislikes = recentFeedback.filter(f => f.type === 'dislike').length;
    const suggestions = recentFeedback.filter(f => f.type === 'suggestion').length;

    // Regenerate queue if:
    // - More dislikes than likes
    // - Or we have explicit suggestions
    return dislikes > likes || suggestions >= 2;
  }

  /**
   * Perform queue update - generate patterns based on queue state
   */
  async performQueueUpdate(updateType = 'periodic') {
    if (!this.isRunning && updateType !== 'initial') return;

    const queueLength = this.state.patternQueue.length;
    const shouldGenerate = updateType === 'initial' || queueLength < this.MIN_QUEUE_LENGTH;

    if (!shouldGenerate) {
      console.log(`📊 Queue OK (${queueLength} patterns)`);
      return;
    }

    console.log(`🎵 Generating queue updates (current: ${queueLength})...`);

    try {
      const context = {
        currentPattern: this.state.currentPattern,
        queue: this.state.patternQueue,
        queueLength: queueLength,
        targetQueueLength: this.TARGET_QUEUE_LENGTH,
        tempo: this.state.tempo
      };

      const recentFeedback = this.getRecentFeedback(10);
      const styleSummary = this.styleMemory.getSummary();

      const operations = await generateQueueOperations(context, recentFeedback, styleSummary);

      this.executeQueueOperations(operations);
    } catch (error) {
      console.error('Error generating queue updates:', error);
    }
  }

  /**
   * Execute queue operations returned by Claude
   */
  executeQueueOperations(operations) {
    if (!Array.isArray(operations)) {
      console.error('Invalid operations format');
      return;
    }

    for (const op of operations) {
      switch (op.action) {
        case 'add':
          this.addPattern(op.pattern, op.bars);
          break;
        case 'insert':
          this.insertPattern(op.index, op.pattern, op.bars);
          break;
        case 'remove':
          this.removePattern(op.id);
          break;
        case 'replace':
          this.replacePattern(op.id, op.pattern, op.bars);
          break;
        case 'clear':
          this.clearQueue();
          break;
        default:
          console.warn(`Unknown operation: ${op.action}`);
      }
    }

    console.log(`✨ Queue updated: ${this.state.patternQueue.length} patterns`);
  }

  addPattern(pattern, bars) {
    const patternObj = {
      id: randomUUID(),
      pattern,
      bars,
      addedAt: Date.now()
    };
    this.state.patternQueue.push(patternObj);
  }

  insertPattern(index, pattern, bars) {
    const patternObj = {
      id: randomUUID(),
      pattern,
      bars,
      addedAt: Date.now()
    };
    this.state.patternQueue.splice(index, 0, patternObj);
  }

  removePattern(id) {
    this.state.patternQueue = this.state.patternQueue.filter(p => p.id !== id);
  }

  replacePattern(id, pattern, bars) {
    const index = this.state.patternQueue.findIndex(p => p.id === id);
    if (index !== -1) {
      this.state.patternQueue[index] = {
        id,
        pattern,
        bars,
        addedAt: Date.now()
      };
    }
  }

  clearQueue() {
    this.state.patternQueue = [];
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
