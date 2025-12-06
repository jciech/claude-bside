import { randomUUID } from 'crypto';

export class QueueProcessor {
  constructor(io, state) {
    this.io = io;
    this.state = state;
    this.agent = null; // Will be set by index.js
    this.isRunning = false;
    this.timeoutId = null;
    this.nextTickTime = null;
    this.currentBar = 0;
  }

  setAgent(agent) {
    this.agent = agent;
  }

  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.currentBar = 0;
    console.log('🎵 Starting queue processor...');

    // Initialize current pattern timing
    this.initializeCurrentPattern();

    // Start the drift-compensating scheduler
    this.scheduleNextTick();

    const barDuration = this.state.tempo.barDuration;
    console.log(`✅ Queue processor started (tick every ${barDuration}ms / 1 bar)`);
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
        console.warn(`⚠️ Scheduler fell behind by ${missedBars} bar(s), catching up`);
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

      console.log(`🎼 Initialized current pattern (${this.state.currentPattern.bars} bars)`);
    }
  }

  processTick() {
    this.currentBar++;

    // Tick the agent's DSL to process automations
    if (this.agent) {
      const result = this.agent.tick(this.currentBar);

      if (result.stateChanged || result.completedAutomations > 0) {
        console.log(`🔄 Bar ${this.currentBar}: state changed, ${result.completedAutomations} automations completed`);
      }
    }
  }

  getQueueInfo() {
    const dslState = this.agent?.getDslState?.()?.state;

    return {
      currentBar: this.currentBar,
      layers: dslState?.layers || {},
      layerOrder: dslState?.layerOrder || [],
      automationCount: dslState?.automationCount || 0,
      tempo: {
        bpm: this.state.tempo.bpm,
        beatsPerBar: this.state.tempo.beatsPerBar
      }
    };
  }
}
