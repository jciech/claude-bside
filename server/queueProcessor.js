import { randomUUID } from 'crypto';

export class QueueProcessor {
  constructor(io, state) {
    this.io = io;
    this.state = state;
    this.isRunning = false;
    this.timeoutId = null;
    this.nextTickTime = null; // When the next tick should fire (absolute time)
  }

  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    console.log('🎵 Starting queue processor...');

    // Initialize current pattern timing
    this.initializeCurrentPattern();

    // Start the drift-compensating scheduler
    this.scheduleNextTick();

    const barDuration = this.state.tempo.barDuration;
    console.log(`✅ Queue processor started (checking every ${barDuration}ms / ${this.state.tempo.beatsPerBar} beats)`);
  }

  /**
   * Drift-compensating scheduler
   * Instead of setInterval (which drifts), we use setTimeout and calculate
   * the next tick based on when it *should* fire, not when it actually did.
   */
  scheduleNextTick() {
    if (!this.isRunning) return;

    const now = Date.now();
    const barDuration = this.state.tempo.barDuration;

    // Initialize or calculate next tick time
    if (this.nextTickTime === null) {
      // First tick: align to bar duration from now
      this.nextTickTime = now + barDuration;
    } else {
      // Subsequent ticks: advance by exactly one bar duration
      this.nextTickTime += barDuration;

      // If we've fallen behind (e.g., CPU was busy), catch up
      // but don't schedule in the past
      if (this.nextTickTime < now) {
        const missedBars = Math.ceil((now - this.nextTickTime) / barDuration);
        console.warn(`⚠️ Scheduler fell behind by ${missedBars} bar(s), catching up`);
        this.nextTickTime = now + barDuration;
      }
    }

    // Schedule the next tick
    const delay = Math.max(0, this.nextTickTime - now);
    this.timeoutId = setTimeout(() => {
      this.processQueue();
      this.scheduleNextTick(); // Schedule the next one
    }, delay);
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.nextTickTime = null;
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
      // Use the scheduled end time as the new start time for seamless transitions
      const transitionTime = this.state.currentPattern.endsAt;

      // Try to get next pattern from queue
      if (this.state.patternQueue.length > 0) {
        const nextPattern = this.state.patternQueue.shift();
        this.playPattern(nextPattern, transitionTime);
      } else {
        // Queue is empty - loop current pattern
        console.log('🔁 Queue empty, looping current pattern');
        this.loopCurrentPattern(transitionTime);
      }
    }
  }

  /**
   * Play a pattern, using the scheduled transition time for seamless timing
   */
  playPattern(patternObj, transitionTime = null) {
    // Use scheduled time if provided, otherwise fall back to now
    const startTime = transitionTime || Date.now();
    const barDuration = this.state.tempo.barDuration;

    this.state.currentPattern = {
      id: patternObj.id,
      pattern: patternObj.pattern,
      bars: patternObj.bars,
      startedAt: startTime,
      endsAt: startTime + (patternObj.bars * barDuration)
    };

    const duration = Math.round((patternObj.bars * barDuration) / 1000);
    console.log(`🎵 Playing next pattern (${patternObj.bars} bars, ${duration}s) - Queue: ${this.state.patternQueue.length} remaining`);

    // Broadcast to all connected clients
    this.io.emit('pattern-update', {
      pattern: this.state.currentPattern.pattern,
      timestamp: startTime,
      bars: patternObj.bars,
      queueLength: this.state.patternQueue.length
    });
  }

  /**
   * Loop current pattern, using the scheduled transition time
   */
  loopCurrentPattern(transitionTime = null) {
    const startTime = transitionTime || Date.now();
    const barDuration = this.state.tempo.barDuration;

    this.state.currentPattern.startedAt = startTime;
    this.state.currentPattern.endsAt = startTime + (this.state.currentPattern.bars * barDuration);

    // Re-broadcast current pattern
    this.io.emit('pattern-update', {
      pattern: this.state.currentPattern.pattern,
      timestamp: startTime,
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
