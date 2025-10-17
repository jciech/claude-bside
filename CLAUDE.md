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
- Critical: Must wait for `editor.prebaked` promise to settle (even if it fails with 404)
- Replace failed prebake promise: `editor.prebaked = Promise.resolve()`
- Pattern playback: Set `editor.code`, call `editor.evaluate()`, then `editor.repl.start()`
- Must resume AudioContext if suspended: Check `state === 'suspended'` and call `ctx.resume()`

**Strudel Prebake Issue:**
- @strudel/repl tries to load `uzu-drumkit.json` from GitHub (returns 404)
- This breaks pattern evaluation if not handled
- Workaround: Catch prebake failure and replace with resolved promise

### Agent Loop

The music generation agent (`server/agent.js`):
- **Auto-starts** when server boots
- **Micro-variations**: Every 15 seconds (configurable)
- **Major changes**: Triggered by 2+ feedback items
- **Style memory**: Tracks community preferences

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

Patterns use Strudel's mini-notation (Tidal Cycles syntax). **IMPORTANT:** Only use synthesis, not samples:

```javascript
// ✅ GOOD - Pure synthesis (works reliably)
note("c3 e3 g3").s("triangle")
note("c1 c2").s("square").lpf(200)
stack(note("c3*4").s("sine"), note("c5 e5").s("sawtooth"))

// ❌ BAD - Samples (require loading from network)
sound("bd sd")  // Tries to load samples, will fail
s("piano")      // Tries to load piano samples
```

**Why synthesis only?**
- Sample loading from GitHub fails (404 errors block playback)
- Synthesis is instant and always available
- Built-in synths: "triangle", "square", "sawtooth", "sine"

### Agent Timing

Located in `server/agent.js`:
```javascript
this.MICRO_VARIATION_INTERVAL = 15000; // 15 seconds
this.MAJOR_CHANGE_FEEDBACK_THRESHOLD = 2; // 2 feedback items
```

Adjust these for different responsiveness. Too fast (<10s) may overwhelm API rate limits.

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
