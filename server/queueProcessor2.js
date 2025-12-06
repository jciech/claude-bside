/**
 * Queue Processor v2
 * Simplified - just ticks bars for transitions
 */

export class QueueProcessor {
  constructor(io, state) {
    this.io = io;
    this.state = state;
    this.agent = null;
    this.isRunning = false;
    this.timeoutId = null;
    this.nextTickTime = null;
    this.currentBar = 0;
  }

  setAgent(agent) {
    this.agent = agent;
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.currentBar = 0;
    console.log('🎵 Starting queue processor v2...');

    this.scheduleNextTick();

    const barDuration = this.state.tempo.barDuration;
    console.log(`✅ Queue processor started (tick every ${barDuration}ms)`);
  }

  scheduleNextTick() {
    if (!this.isRunning) return;

    const now = Date.now();
    const barDuration = this.state.tempo.barDuration;

    if (this.nextTickTime === null) {
      this.nextTickTime = now + barDuration;
    } else {
      this.nextTickTime += barDuration;

      if (this.nextTickTime < now) {
        const missedBars = Math.ceil((now - this.nextTickTime) / barDuration);
        console.warn(`⚠️ Scheduler fell behind by ${missedBars} bar(s)`);
        this.currentBar += missedBars;
        this.nextTickTime = now + barDuration;
      }
    }

    const delay = Math.max(0, this.nextTickTime - now);
    this.timeoutId = setTimeout(() => {
      this.processTick();
      this.scheduleNextTick();
    }, delay);
  }

  stop() {
    if (!this.isRunning) return;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.nextTickTime = null;
    this.isRunning = false;
    console.log('⏹️ Queue processor stopped');
  }

  processTick() {
    this.currentBar++;

    // Tick the agent's music state
    if (this.agent) {
      this.agent.tick(this.currentBar);
    }
  }

  getCurrentBar() {
    return this.currentBar;
  }
}
