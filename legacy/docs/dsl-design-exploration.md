# DSL Design Exploration

## Current Problems

1. **Pattern strings carry all expressiveness** - Our DSL is just a thin wrapper
2. **Effects split between pattern and layer** - Confusing, duplicative
3. **CRUD operations don't match musical thinking** - Musicians don't "add" and "remove"
4. **Layers may not be the right primitive** - What do musicians actually think about?

## What Musicians Actually Do

From the DJ_Dave example and general music production:

1. **Build up sections** - Intro, verse, build, drop, breakdown
2. **Bring elements in/out** - Not binary on/off, but gradual
3. **Transform over time** - Filter sweeps, gain changes, pattern evolution
4. **Create tension and release** - Energy arcs, not flat states
5. **Work with grooves/textures** - Rhythm + harmony + timbre together

## Design Direction A: Simplify - Pattern-Centric

What if we embrace that **patterns ARE the language** and our DSL just manages them?

```javascript
// The pattern IS the layer. Minimal wrapping.
{
  "voices": {
    "rhythm": "s(\"bd(3,8), hh*8?\").gain(0.7)",
    "bass": "note(\"<c2 eb2 g2>\").s(\"sawtooth\").lpf(400)",
    "texture": "s(\"swpad:3\").slow(8).room(0.8)"
  },
  "bpm": 120
}

// Claude just updates the patterns directly
// No separate gain/effects - it's all in the pattern string
```

**Pros:**
- Simple, transparent - what you see is what plays
- Full Strudel expressiveness
- No confusion about where effects live

**Cons:**
- Hard to do gradual transitions (gain fades) without parsing patterns
- Can't easily mute without removing

## Design Direction B: Transformation-Centric

What if operations describe *transformations* rather than CRUD?

```javascript
// Instead of add/update/remove, describe transformations
{ "transform": "introduce", "voice": "drums", "over": 4 }  // fade in over 4 bars
{ "transform": "withdraw", "voice": "bass", "over": 2 }    // fade out
{ "transform": "evolve", "voice": "rhythm", "to": "s(\"bd*4\").mask(...)"}
{ "transform": "intensify", "voices": ["drums", "bass"] }  // increase energy
{ "transform": "strip", "keep": ["texture"] }              // mute all but texture
```

**Pros:**
- Matches musical language better
- Implies gradual transitions by default
- More compositional thinking

**Cons:**
- More complex to implement
- "Intensify" is vague - what does it mean concretely?

## Design Direction C: State-Based with Interpolation

What if we just describe the target state and the system interpolates?

```javascript
{
  "target": {
    "rhythm": { "pattern": "s(\"bd*4\")", "level": 0.8 },
    "bass": { "pattern": "...", "level": 0 },  // fading out
    "texture": { "pattern": "...", "level": 0.5 }
  },
  "transition": 4,  // bars to reach target
  "bpm": 120
}
```

**Pros:**
- Declarative - describe where you want to be
- Automatic interpolation for all changes
- Simpler mental model

**Cons:**
- Loses the ability to say "just change this one thing"
- Pattern changes are still instant (can't interpolate pattern content)

## Design Direction D: Musical Sections

What if the primitive is the *section* rather than the layer?

```javascript
{
  "section": "build",
  "character": "rising tension, adding elements",
  "voices": {
    "foundation": "s(\"swpad:3\").slow(8)",
    "rhythm": "s(\"bd(3,8), hh*4?\")",
    "movement": "note(\"<c3 e3 g3>\").s(\"sine\")"
  },
  "energy": 0.7,
  "next_hint": "drop"  // what might come next
}
```

**Pros:**
- Matches how musicians think about song structure
- "Character" gives Claude creative guidance
- Natural arc from section to section

**Cons:**
- Transitions between sections still need handling
- More abstract, less direct control

## Hybrid Proposal

Combine the best ideas:

1. **Voices (not layers)** - Each voice is a pattern string + level
2. **Levels (not gain)** - 0-1, controls presence/prominence
3. **Transitions are implicit** - Changes happen over N bars by default
4. **Sections as snapshots** - Can save/recall voice configurations
5. **Pattern string is sacred** - All musical expressiveness stays there

```javascript
// Response format
{
  "voices": {
    "rhythm": { "pattern": "s(\"bd(3,8)\")", "level": 0.8 },
    "texture": { "pattern": "s(\"swpad:3\").slow(8).room(0.8)", "level": 0.5 }
  },
  "transition": 2,     // bars for level changes to complete
  "bpm": 120,
  "intent": "Building the groove"
}

// Or incremental updates
{
  "set": {
    "rhythm.level": 0,  // will fade out over transition bars
    "bass.pattern": "note(\"<c2 g2>\").s(\"sine\")"
  },
  "transition": 4,
  "intent": "Stripping to bass"
}
```

## Key Insights

1. **The pattern string IS the music** - Don't fight this
2. **Levels are cleaner than gain** - Single source of truth for prominence
3. **Implicit transitions are more musical** - Everything gradual by default
4. **Named sections are useful** - But as snapshots, not as the core abstraction
5. **Intent matters** - Claude should explain its musical thinking

## Multi-Voice Transitions

A critical insight: musical transitions often involve **coordinated changes across multiple voices**.

### Examples of Multi-Voice Transitions

**The Drop:**
```
Bar 0:  texture: 0.8, drums: 0.0, bass: 0.3
Bar 4:  texture: 0.3, drums: 1.0, bass: 0.8  ← everything moves together
```

**The Build:**
```
Bar 0:  kick only at 0.5
Bar 4:  kick 0.6, add hats at 0.3
Bar 8:  kick 0.7, hats 0.5, add bass at 0.4
Bar 12: kick 0.8, hats 0.6, bass 0.6, add lead at 0.3
```

**The Strip/Breakdown:**
```
Bar 0:  all voices playing
Bar 4:  only texture remains, everything else → 0
```

### Design: Transition Objects

What if we describe the *transition* as a first-class object?

```javascript
{
  "transition": {
    "over": 4,  // bars
    "changes": {
      "drums": { "level": 1.0 },           // fade in
      "bass": { "level": 0.8, "pattern": "..." },  // change + fade
      "texture": { "level": 0.3 },         // pull back
      "lead": { "level": 0 }               // fade out
    }
  },
  "intent": "Dropping into the groove"
}
```

Or even more compositionally:

```javascript
{
  "transition": {
    "type": "drop",          // or "build", "strip", "evolve"
    "over": 4,
    "target": {
      "drums": 1.0,
      "bass": 0.8,
      "texture": 0.3,
      "lead": 0
    }
  }
}
```

### Staggered/Choreographed Transitions

Even more expressive - different voices can have different timing:

```javascript
{
  "choreography": [
    { "voice": "texture", "level": 0.2, "at": 0, "over": 2 },   // starts immediately
    { "voice": "drums", "level": 0.8, "at": 2, "over": 1 },     // drums hit at bar 2
    { "voice": "bass", "level": 0.7, "at": 3, "over": 2 },      // bass follows
  ],
  "intent": "Staggered drop, building anticipation"
}
```

This is like a musical score - describing when each voice enters/changes.

### Simplest Expressive Form

Maybe we just need two primitives:

1. **State**: What voices exist and their patterns
2. **Target**: Where we want to be (levels) and how long to get there

```javascript
// Full state (for initialization or major changes)
{
  "state": {
    "rhythm": { "p": "s(\"bd(3,8)\")", "l": 0.8 },
    "texture": { "p": "s(\"swpad:3\").slow(8)", "l": 0.5 }
  },
  "bpm": 120
}

// Target (for transitions)
{
  "target": {
    "rhythm": 1.0,      // just level
    "texture": 0.2,
    "bass": { "p": "note(\"c2\").s(\"sine\")", "l": 0.6 }  // add new voice
  },
  "over": 4,
  "intent": "Building energy"
}
```

The system interpolates levels, instantly applies pattern changes (at bar boundaries).

### Key Principle

**Transitions are the music, not the states.**

A static arrangement isn't interesting. The *movement* between states is where the music lives. Our DSL should make transitions first-class, not afterthoughts.

## Questions to Resolve

1. Should effects (room, delay) be part of pattern or separate?
2. How do we handle pattern transitions (can't crossfade code)?
3. Is BPM a first-class control or separate?
4. How expressive should choreography be?
5. Should we support staggered voice entries?
