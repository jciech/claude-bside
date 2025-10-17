# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start Commands

```bash
# Install dependencies
npm install

# Set API key (required)
echo "ANTHROPIC_API_KEY=sk-ant-your-key-here" > .env

# Run backend server (Terminal 1)
npm run server      # Production
npm run server:dev  # Development with auto-reload

# Run frontend dev server (Terminal 2)
npm run client      # Vite dev server on port 5173

# Access the app
# Open http://localhost:5173 in browser
```

## Architecture Overview

### Dual-Server Setup

This project requires **TWO separate servers** running simultaneously:

1. **Backend (port 3000)**: Express + Socket.io
   - Handles WebSocket connections
   - Runs the AI agent (auto-starts on boot)
   - Generates music patterns via Claude API

2. **Frontend (port 5173)**: Vite dev server
   - Serves the client application
   - Proxies `/api` and `/socket.io` to backend
   - Hot module reload for development

### Audio Architecture

**Critical:** Uses a hidden `<strudel-editor>` web component to handle audio playback.

The `<strudel-editor>` component (from CDN: `https://unpkg.com/@strudel/repl@latest`):
- Positioned off-screen: `position: fixed; top: -9999px`
- Provides a `StrudelMirror` instance via `element.editor`
- Handles all Web Audio initialization internally

**AudioManager** (`public/src/audioManager.js`):
- Waits for `element.editor` to be available
- Handles `editor.prebaked` promise (default samples, may fail with 404)
- Loads custom samples after initialization:
  - `samples('github:switchangel/breaks')` - drum breaks and percussion
  - `samples('github:switchangel/pad')` - atmospheric pad sounds
- Pattern playback: Set `editor.code`, call `editor.evaluate()`, then `editor.repl.start()`
- Must resume AudioContext if suspended: Check `state === 'suspended'` and call `ctx.resume()`

**Sample Loading:**
- The `samples()` function is globally available after strudel-editor initializes
- Custom samples are loaded in `loadCustomSamples()` after editor is ready
- Falls back to evaluating samples() as code if not globally available
- Sample maps load immediately; audio files load lazily on first play

### Agent Loop and Queue System

The music uses a **queue-based architecture** with two independent loops:

1. **Queue Processor** (`server/queueProcessor.js`):
   - Rhythm-aware REPL update loop
   - Checks every bar boundary (based on BPM)
   - Transitions patterns on musical boundaries
   - Falls back to looping if queue is empty

2. **Music Agent** (`server/agent.js`):
   - Claude generation loop (every 20 seconds)
   - Maintains queue of 4-6 patterns ahead
   - Generates queue operations (add, insert, remove, replace, clear)
   - Responds to feedback by modifying queue
   - **Style memory**: Tracks community preferences

**Musical Timing:**
- Default: 120 BPM, 4/4 time signature
- Patterns specify duration in **bars** (not seconds)
- Bar duration = `(60000 / BPM) * 4` milliseconds
- All transitions happen on bar boundaries

### Key Dependencies

- **@strudel/\***: Music pattern engine (TidalCycles in JS)
- **@anthropic-ai/sdk**: Claude API for pattern generation
- **socket.io**: Real-time bi-directional communication
- **Vite**: Frontend bundler (needed for ES module imports)

## Development Gotchas

### npm vs Other Package Managers

This project uses **npm** with a custom registry config in `.npmrc`:
```
# .npmrc
registry=https://registry.npmjs.org/
```

The lockfile is `package-lock.json`. Don't use yarn/pnpm unless you regenerate lockfiles.

### Environment Variables

**Required:**
- `ANTHROPIC_API_KEY` - Must be set or audio generation fails with 401 errors

The server uses `dotenv/config` auto-import at the top of `server/index.js`.

### Port Conflicts

- Backend must run on **3000** (hardcoded in Vite proxy)
- Frontend dev server on **5173** (Vite default)
- If ports are taken, you'll need to update `vite.config.js` proxy settings

### Strudel Pattern Syntax

Patterns use Strudel's mini-notation (Tidal Cycles syntax). Both synthesis and samples are supported:

**Synthesis** (always available, instant):
```javascript
note("c3 e3 g3").s("triangle")
note("c1 c2").s("square").lpf(200)
stack(note("c3*4").s("sine"), note("c5 e5").s("sawtooth"))
```

**Samples** (loaded from switchangel repos):
```javascript
s("breaks:7").loopAt(2).fit()       // Drum breaks
s("swpad:0").slow(4).room(0.8)      // Atmospheric pads
```

**Hybrid** (mix synthesis and samples):
```javascript
stack(
  s("breaks:2*4"),
  note("c2 e2 g2").s("sine").lpf(400)
)
```

**Available Sample Banks:**
- `breaks:N` - Drum breaks and percussion loops from switchangel/breaks
- `swpad:N` - Atmospheric pad sounds from switchangel/pad
- Built-in synths: "triangle", "square", "sawtooth", "sine"

### Agent Configuration

Located in `server/agent.js`:
```javascript
this.GENERATION_INTERVAL = 20000; // Check queue every 20 seconds
this.MIN_QUEUE_LENGTH = 3; // Minimum patterns to maintain
this.TARGET_QUEUE_LENGTH = 5; // Target queue length
this.MAJOR_CHANGE_FEEDBACK_THRESHOLD = 2; // Feedback for queue regeneration
```

Located in `server/index.js`:
```javascript
tempo: {
  bpm: 120,
  beatsPerBar: 4
}
```

**Pattern Duration Calculation:**
```javascript
duration_ms = bars * beatsPerBar * (60000 / bpm)
// Example: 8 bars at 120 BPM = 8 * 4 * 500 = 16000ms (16 seconds)
```

### WebSocket Connection

Frontend connects to backend via Socket.io:
- In dev: Vite proxies `/socket.io` → `http://localhost:3000`
- Client must connect AFTER backend is running
- Check browser console for connection errors

## Code Style

**Commenting Philosophy:**
- Avoid redundant comments that just restate the code
- Only comment non-obvious implementation details or workarounds
- Function names should be self-explanatory
- Keep code clean and minimal

Example - avoid:
```javascript
// Set the code
this.editor.code = code;  // Sets code property
```

Instead, only comment the non-obvious:
```javascript
// Wait for prebake, replace if it fails (404 on uzu-drumkit.json)
this.editor.prebaked = Promise.resolve();
```

## Project Structure

```
claude-bside/
├── server/               # Backend (Node.js)
│   ├── index.js         # Express + Socket.io + auto-start agent
│   ├── agent.js         # Music generation loop
│   ├── claude.js        # Claude API calls
│   └── memory.js        # Style preference tracker
├── public/              # Frontend (Vite serves this)
│   ├── src/
│   │   ├── main.js      # Entry point + WebSocket client
│   │   └── audioManager.js  # Strudel audio wrapper
│   ├── index.html       # Landing page + main UI
│   └── style.css
├── vite.config.js       # Vite config with proxy
└── .env                 # API keys (gitignored)
```
- You can read the opensource strudel.cc repository under ../strudel. If its not there, you might want to ask the user to fetch it for you so you can use it to understand the strudel APIs better.