import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { MusicAgent } from './agent2.js';
import { QueueProcessor } from './queueProcessor2.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// Store connected clients and current state
const state = {
  tempo: {
    bpm: 120,
    beatsPerBar: 4,
    get beatDuration() { return 60000 / this.bpm; },
    get barDuration() { return (60000 / this.bpm) * this.beatsPerBar; }
  },
  currentPattern: {
    id: null,
    pattern: 'silence',
    bars: 4,
    startedAt: null,
    endsAt: null
  },
  clients: new Set(),
  feedback: []
};

// Initialize the music agent and queue processor
const queueProcessor = new QueueProcessor(io, state);
const agent = new MusicAgent(io, state);

// Wire up the agent to the queue processor for tick callbacks
queueProcessor.setAgent(agent);

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  state.clients.add(socket.id);

  // Send current music state to newly connected client
  const musicState = agent.getMusicState();
  socket.emit('music-update', {
    compiled: agent.getCompiled(),
    state: musicState,
    bpm: musicState.bpm,
    intent: null,
    timestamp: Date.now()
  });

  // Send feedback history
  socket.emit('feedback-history', state.feedback);

  // Handle feedback from clients
  socket.on('feedback', async (data) => {
    console.log('Received feedback:', data);

    const feedbackItem = {
      id: socket.id,
      type: data.type,
      content: data.content,
      timestamp: Date.now(),
      patternId: state.currentPattern.id,
      pattern: state.currentPattern.pattern
    };

    state.feedback.push(feedbackItem);
    io.emit('feedback-update', feedbackItem);

    if (agent.isRunning) {
      await agent.processFeedback(feedbackItem);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    state.clients.delete(socket.id);
  });
});

// API endpoints
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    clients: state.clients.size,
    feedback: state.feedback.length,
    agentRunning: agent.isRunning
  });
});

app.get('/api/music/state', (req, res) => {
  res.json(agent.getMusicState());
});

app.post('/api/agent/start', (req, res) => {
  agent.start();
  res.json({ success: true, message: 'Agent started' });
});

app.post('/api/agent/stop', (req, res) => {
  agent.stop();
  res.json({ success: true, message: 'Agent stopped' });
});

app.get('/api/style/summary', (req, res) => {
  res.json(agent.getStyleSummary());
});

httpServer.listen(PORT, () => {
  console.log(`🎵 Claude B-Side v2 server running on http://localhost:${PORT}`);
  console.log(`Connected clients: 0`);
  console.log(`Tempo: ${state.tempo.bpm} BPM`);

  // Auto-start
  console.log('\n🎼 Auto-starting queue processor...');
  queueProcessor.start();

  console.log('\n🤖 Auto-starting music agent...');
  agent.start();
});
