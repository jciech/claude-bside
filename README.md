# Claude B-Side

A collaborative AI music streaming platform where Claude generates live music using Strudel, and multiple users can provide real-time feedback to shape the music together.

**Perfect for remote listening parties**: 50+ people can listen to the same AI-generated music stream, giving feedback that shapes what plays next!

## Features

- **Seamless auto-play**: One click starts continuous music playback
- **Real-time collaborative streaming**: Everyone hears the same music simultaneously
- **Hybrid agentic loop**: Fast micro-variations (15s) + feedback-driven major changes
- **Multi-user feedback**: Like/dislike buttons and text suggestions
- **Style memory**: Learns from community preferences over time
- **Passive listening**: Click once, then listen for hours

## How It Works

### For Listeners

1. **Click "Start Listening"** - One-time button click to initialize audio
2. **Music plays automatically** - New patterns every 15 seconds, seamless transitions
3. **Give feedback anytime** - Like, dislike, or suggest changes
4. **Listen passively** - No more clicking required, just enjoy!

### Under the Hood

1. **Queue Processor**: Transitions patterns on bar boundaries based on BPM
2. **Claude Generation Loop**: Maintains 4-6 patterns in queue, checks every 20s
3. **Musical timing**: 120 BPM, patterns specify duration in bars (4, 8, 16, 32)
4. **Feedback triggers changes**: 2+ pieces of feedback → queue regeneration
5. **Style learning**: System tracks what the community likes
6. **Auto-start**: Both queue processor and agent start when server boots

## Tech Stack

- **Backend**: Node.js, Express, Socket.io
- **Frontend**: Vite + vanilla JS, Strudel libraries (@strudel/core, @strudel/webaudio)
- **AI**: Anthropic Claude Sonnet 4.5
- **Audio**: Web Audio API via Strudel

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up API Key

Create a `.env` file:
```bash
echo "ANTHROPIC_API_KEY=your_api_key_here" > .env
```

Or export it:
```bash
export ANTHROPIC_API_KEY=your_api_key_here
```

### 3. Start the Backend Server

```bash
npm run server
```

Server runs on http://localhost:3000

### 4. Start the Frontend Dev Server

In a **separate terminal**:
```bash
npm run client
```

Vite dev server runs on http://localhost:5173

### 5. Open in Browser

Navigate to **http://localhost:5173**

**Click "🎧 Start Listening"** and enjoy continuous AI-generated music!

## Important Notes

- **Queue-based system**: Patterns are queued and transition on musical bar boundaries
- **Musical timing**: Runs at 120 BPM by default with bar-synchronized transitions
- **Samples & synthesis**: Uses switchangel breaks/pads plus built-in synths
- **One click to start**: Browser requires user interaction to enable audio
- **Auto-play**: New patterns transition automatically based on bar duration
- **Claude controls the queue**: AI manages 4-6 patterns ahead, adapts to feedback

## Development

### Run Both Servers

Terminal 1:
```bash
npm run server:dev  # Backend with auto-reload
```

Terminal 2:
```bash
npm run client  # Frontend with HMR
```

### Available Scripts

- `npm run server` - Start backend server
- `npm run server:dev` - Start backend with auto-reload
- `npm run client` - Start Vite dev server
- `npm run client:build` - Build production frontend
- `npm start` - Alias for `npm run server`
- `npm run dev` - Alias for `npm run server:dev`

## Project Structure

```
claude-bside/
├── server/              # Backend (Node.js + Express)
│   ├── index.js         # Main server + WebSocket
│   ├── agent.js         # Music generation agent (queue operations)
│   ├── queueProcessor.js # Rhythm-aware REPL update loop
│   ├── claude.js        # Claude API integration
│   └── memory.js        # Style memory system
├── public/              # Frontend (served by Vite)
│   ├── src/
│   │   ├── main.js      # Client entry point
│   │   └── audioManager.js  # Strudel audio manager
│   ├── index.html       # Landing page + main UI
│   └── style.css        # Styling
├── vite.config.js       # Vite configuration
└── package.json
```

## API Endpoints

- `POST /api/agent/start` - Manually start the agent (auto-starts on boot)
- `POST /api/agent/stop` - Stop the agent
- `GET /api/queue` - Get queue status (current pattern, queued patterns, BPM)
- `GET /api/style/summary` - Get current style preferences
- `GET /api/style/export` - Export style profile as JSON
- `POST /api/pattern` - Manually update pattern (for testing)
- `GET /api/health` - Health check

## Configuration

### Agent Settings

Edit `server/agent.js` to adjust:
- `GENERATION_INTERVAL` - Queue check interval (default: 20 seconds)
- `MIN_QUEUE_LENGTH` - Minimum patterns in queue (default: 3)
- `TARGET_QUEUE_LENGTH` - Target queue length (default: 5)
- `MAJOR_CHANGE_FEEDBACK_THRESHOLD` - Feedback for queue regeneration (default: 2)

### Tempo Settings

Edit `server/index.js` to adjust:
- `bpm` - Beats per minute (default: 120)
- `beatsPerBar` - Time signature (default: 4)

### Audio & Timing

**Web Audio**: Requires one user interaction before audio can play (browser security). After "Start Listening", patterns auto-play.

**Musical Timing**: Pattern transitions happen on bar boundaries for smooth, musical flow:
- Duration = `bars × beatsPerBar × (60000 / BPM)` milliseconds
- Example: 8 bars at 120 BPM = 16 seconds
- Queue processor checks on every bar (every 2 seconds at 120 BPM)

## Deployment

### Production Build

```bash
npm run client:build  # Builds to ./dist
```

Then serve `dist/` directory and run the backend server.

## Troubleshooting

**No audio playing?**
- Make sure you clicked "Start Listening" on the landing page
- Check browser console for errors
- Verify `ANTHROPIC_API_KEY` is set

**Patterns not generating?**
- Check backend logs for API errors
- Verify agent is running (check `/api/health`)
- Ensure API key is valid

**WebSocket not connecting?**
- Make sure backend is running on port 3000
- Check Vite proxy config in `vite.config.js`
- Look for CORS errors in console

## License

AGPL-3.0-or-later (required by Strudel dependency)

## Credits

- Built with [Strudel](https://strudel.cc) by Felix Roos and contributors
- Powered by [Claude](https://anthropic.com/claude) by Anthropic
- Inspired by the live coding and algorave communities
