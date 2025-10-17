# Claude B-Side Usage Guide

## Quick Start

1. **Set your API key:**
```bash
export ANTHROPIC_API_KEY=your_api_key_here
```

2. **Start the server:**
```bash
npm start
```

3. **Open the web interface:**
   - Navigate to http://localhost:3000 in your browser
   - You should see the Claude B-Side interface with a Strudel REPL

4. **Start the AI agent:**
```bash
curl -X POST http://localhost:3000/api/agent/start
```

## How It Works

### The Agentic Loop

The system runs in a **hybrid mode**:

- **Micro-variations** (every 45 seconds): The agent makes small tweaks to the current pattern
  - Slightly different rhythms
  - Add/remove one element
  - Tweak effects

- **Major changes** (on feedback): When users provide feedback, the agent considers making bigger changes
  - Triggered by: more dislikes than likes, or 2+ suggestions
  - Can change genre, tempo, or structure

### Giving Feedback

1. **Like button (👍)**: Tell the agent you're enjoying the current pattern
2. **Dislike button (👎)**: Signal that the current pattern isn't working
3. **Suggestions**: Type what you'd like (e.g., "more bass", "faster tempo", "add jazz vibes")

### Style Memory

The system learns from your feedback:
- Tracks which elements you like/dislike
- Remembers tempo preferences
- Builds a profile of community taste
- Uses this to inform future generations

## API Endpoints

### Agent Control

**Start the agent:**
```bash
curl -X POST http://localhost:3000/api/agent/start
```

**Stop the agent:**
```bash
curl -X POST http://localhost:3000/api/agent/stop
```

### Style Information

**Get current style preferences:**
```bash
curl http://localhost:3000/api/style/summary
```

**Export full style profile:**
```bash
curl http://localhost:3000/api/style/export > style-profile.json
```

### Manual Pattern Control (for testing)

**Update pattern manually:**
```bash
curl -X POST http://localhost:3000/api/pattern \
  -H "Content-Type: application/json" \
  -d '{"pattern": "sound(\"bd sd, hh*8\").fast(2)"}'
```

### Health Check

```bash
curl http://localhost:3000/api/health
```

## Collaborative Sessions

Multiple people can connect to the same instance:

1. Share the URL (http://your-server:3000) with collaborators
2. Everyone sees the same pattern playing
3. All feedback is aggregated and visible to everyone
4. The agent responds to the collective community input

## Tips for Best Results

1. **Be patient**: Give each pattern 30-60 seconds to evolve
2. **Be specific**: "More bass" is better than just "change it"
3. **React honestly**: The agent learns from genuine feedback
4. **Collaborate**: Multiple perspectives make for more interesting music
5. **Have fun**: Experiment and see where the music goes!

## Troubleshooting

**Pattern not playing?**
- Check browser console for errors
- Make sure Strudel REPL loaded (refresh page)
- Try clicking on the Strudel editor to give it focus

**Agent not generating new patterns?**
- Make sure you started the agent (`POST /api/agent/start`)
- Check you have `ANTHROPIC_API_KEY` set
- Look at server logs for errors

**No audio?**
- Check browser audio permissions
- Make sure volume is up
- Try clicking on the page (some browsers require user interaction first)
