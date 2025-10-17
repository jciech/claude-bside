import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { MusicAgent } from './agent.js';
import { QueueProcessor } from './queueProcessor.js';

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
  patternQueue: [],
  currentPattern: {
    id: null,
    pattern: `s("breaks:7").loopAt(2).fit().room(.4).delay(.25).cps(2)`,
    bars: 8,
    startedAt: null,
    endsAt: null
  },
  clients: new Set(),
  feedback: []
};

// Initialize the music agent and queue processor
const queueProcessor = new QueueProcessor(io, state);
const agent = new MusicAgent(io, state, queueProcessor);

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  state.clients.add(socket.id);

  // Send current pattern to newly connected client
  socket.emit('pattern-update', {
    pattern: state.currentPattern.pattern,
    bars: state.currentPattern.bars,
    timestamp: Date.now()
  });

  // Send current feedback history
  socket.emit('feedback-history', state.feedback);

  // Handle feedback from clients
  socket.on('feedback', async (data) => {
    console.log('Received feedback:', data);

    const feedbackItem = {
      id: socket.id,
      type: data.type, // 'like', 'dislike', or 'suggestion'
      content: data.content,
      timestamp: Date.now()
    };

    state.feedback.push(feedbackItem);

    // Broadcast feedback to all clients
    io.emit('feedback-update', feedbackItem);

    // Process feedback with agent
    if (agent.isRunning) {
      await agent.processFeedback(feedbackItem);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    state.clients.delete(socket.id);
  });
});

// API endpoint to manually update pattern (for testing)
app.post('/api/pattern', express.json(), (req, res) => {
  const { pattern } = req.body;

  if (!pattern) {
    return res.status(400).json({ error: 'Pattern is required' });
  }

  state.currentPattern = pattern;

  // Broadcast new pattern to all connected clients
  io.emit('pattern-update', {
    pattern: state.currentPattern,
    timestamp: Date.now()
  });

  res.json({ success: true, pattern: state.currentPattern });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    clients: state.clients.size,
    feedback: state.feedback.length,
    agentRunning: agent.isRunning
  });
});

// Start the agent
app.post('/api/agent/start', (req, res) => {
  agent.start();
  res.json({ success: true, message: 'Agent started' });
});

// Stop the agent
app.post('/api/agent/stop', (req, res) => {
  agent.stop();
  res.json({ success: true, message: 'Agent stopped' });
});

// Get style summary
app.get('/api/style/summary', (req, res) => {
  const summary = agent.getStyleSummary();
  res.json(summary);
});

// Export style profile
app.get('/api/style/export', (req, res) => {
  const profile = agent.exportStyleProfile();
  res.json(profile);
});

// Get queue status
app.get('/api/queue', (req, res) => {
  const queueInfo = queueProcessor.getQueueInfo();
  res.json(queueInfo);
});

httpServer.listen(PORT, () => {
  console.log(`🎵 Claude B-Side server running on http://localhost:${PORT}`);
  console.log(`Connected clients: 0`);
  console.log(`Tempo: ${state.tempo.bpm} BPM`);
  console.log('\n📝 API Endpoints:');
  console.log('  POST /api/agent/start - Start the AI agent');
  console.log('  POST /api/agent/stop - Stop the AI agent');
  console.log('  GET  /api/style/summary - Get style preferences');
  console.log('  GET  /api/style/export - Export style profile');
  console.log('  GET  /api/queue - Get queue status');

  // Auto-start the queue processor and agent
  console.log('\n🎼 Auto-starting queue processor...');
  queueProcessor.start();

  console.log('\n🤖 Auto-starting music agent...');
  agent.start();
});
