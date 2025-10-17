import { randomUUID } from 'crypto';

export class QueueProcessor {
  constructor(io, state) {
    this.io = io;
    this.state = state;
    this.isRunning = false;
    this.intervalId = null;
  }

  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    console.log('🎵 Starting queue processor...');

    // Initialize current pattern timing
    this.initializeCurrentPattern();

    // Run on bar boundaries
    const checkInterval = this.state.tempo.barDuration;
    this.intervalId = setInterval(() => {
      this.processQueue();
    }, checkInterval);

    console.log(`✅ Queue processor started (checking every ${checkInterval}ms / ${this.state.tempo.beatsPerBar} beats)`);
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    clearInterval(this.intervalId);
    this.isRunning = false;
    console.log('⏹️  Queue processor stopped');
  }

  initializeCurrentPattern() {
    if (!this.state.currentPattern.startedAt) {
      const now = Date.now();
      this.state.currentPattern.id = randomUUID();
      this.state.currentPattern.startedAt = now;
      this.state.currentPattern.endsAt = now + (this.state.currentPattern.bars * this.state.tempo.barDuration);

      console.log(`🎼 Initialized current pattern (${this.state.currentPattern.bars} bars, ends in ${Math.round((this.state.currentPattern.endsAt - now) / 1000)}s)`);
    }
  }

  processQueue() {
    const now = Date.now();

    // Check if current pattern has finished
    if (now >= this.state.currentPattern.endsAt) {
      // Try to get next pattern from queue
      if (this.state.patternQueue.length > 0) {
        const nextPattern = this.state.patternQueue.shift();
        this.playPattern(nextPattern);
      } else {
        // Queue is empty - loop current pattern
        console.log('🔁 Queue empty, looping current pattern');
        this.loopCurrentPattern();
      }
    }
  }

  playPattern(patternObj) {
    const now = Date.now();

    this.state.currentPattern = {
      id: patternObj.id,
      pattern: patternObj.pattern,
      bars: patternObj.bars,
      startedAt: now,
      endsAt: now + (patternObj.bars * this.state.tempo.barDuration)
    };

    const duration = Math.round((this.state.currentPattern.endsAt - now) / 1000);
    console.log(`🎵 Playing next pattern (${patternObj.bars} bars, ${duration}s) - Queue: ${this.state.patternQueue.length} remaining`);

    // Broadcast to all connected clients
    this.io.emit('pattern-update', {
      pattern: this.state.currentPattern.pattern,
      timestamp: now,
      bars: patternObj.bars,
      queueLength: this.state.patternQueue.length
    });
  }

  loopCurrentPattern() {
    const now = Date.now();
    this.state.currentPattern.startedAt = now;
    this.state.currentPattern.endsAt = now + (this.state.currentPattern.bars * this.state.tempo.barDuration);

    // Re-broadcast current pattern
    this.io.emit('pattern-update', {
      pattern: this.state.currentPattern.pattern,
      timestamp: now,
      bars: this.state.currentPattern.bars,
      queueLength: 0
    });
  }

  getQueueInfo() {
    return {
      currentPattern: {
        pattern: this.state.currentPattern.pattern,
        bars: this.state.currentPattern.bars,
        remainingMs: Math.max(0, this.state.currentPattern.endsAt - Date.now())
      },
      queue: this.state.patternQueue.map(p => ({
        id: p.id,
        bars: p.bars,
        preview: p.pattern.substring(0, 60) + '...'
      })),
      queueLength: this.state.patternQueue.length,
      tempo: {
        bpm: this.state.tempo.bpm,
        beatsPerBar: this.state.tempo.beatsPerBar
      }
    };
  }
}
