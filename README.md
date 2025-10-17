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

1. **Micro-variations** (every 15 seconds): Claude tweaks the current pattern
2. **Feedback triggers changes**: 2+ pieces of feedback → major evolution
3. **Style learning**: System tracks what the community likes
4. **Auto-start agent**: Music generation begins when server starts

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

- **Synthesis only**: Patterns use pure synthesis (note() + synths) not samples
- **One click to start**: Browser requires user interaction to enable audio
- **Auto-play after**: Once started, new patterns play automatically every 15 seconds
- **Patterns evolve**: Small variations continuously, major changes based on feedback

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
│   ├── agent.js         # Music generation agent
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
- `GET /api/style/summary` - Get current style preferences
- `GET /api/style/export` - Export style profile as JSON
- `POST /api/pattern` - Manually update pattern (for testing)
- `GET /api/health` - Health check

## Configuration

### Agent Settings

Edit `server/agent.js` to adjust:
- `MICRO_VARIATION_INTERVAL` - Time between pattern changes (default: 15 seconds)
- `MAJOR_CHANGE_FEEDBACK_THRESHOLD` - Feedback needed for major changes (default: 2)

### Audio Initialization

The system uses Web Audio API which requires **one user interaction** before audio can play. This is a browser security feature. After the initial "Start Listening" click, all subsequent patterns play automatically.

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
