import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Generate DSL operations for the layer-based music system
 */
export async function generateDslOperations(context, feedback, styleMemory) {
  const systemPrompt = buildSystemPrompt(styleMemory, context.tempo);
  const userPrompt = buildUserPrompt(context, feedback);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
    });

    const response = message.content[0].text;
    return extractOperations(response);
  } catch (error) {
    console.error('Error generating DSL operations:', error);
    throw error;
  }
}

function buildSystemPrompt(styleMemory, tempo) {
  const bpm = tempo?.bpm || 120;

  // Pick a random style direction for variety
  const styles = [
    { name: 'minimal techno', lead: 'bd', texture: 'hh', character: 'driving, hypnotic, repetitive with subtle variation' },
    { name: 'ambient', lead: 'swpad', texture: 'sine', character: 'spacious, evolving, textural' },
    { name: 'breakbeat', lead: 'breaks', texture: 'cp', character: 'chopped, syncopated, energetic' },
    { name: 'dub', lead: 'sine bass', texture: 'delay-heavy', character: 'deep, spacey, echo-drenched' },
    { name: 'idm/glitch', lead: 'ply patterns', texture: 'noise', character: 'unpredictable, fractured, complex' },
    { name: 'house', lead: 'bd*4', texture: 'oh', character: 'four-on-floor, groovy, uplifting' },
    { name: 'drone', lead: 'slow chords', texture: 'room', character: 'sustained, meditative, evolving slowly' },
    { name: 'percussion-forward', lead: 'euclidean drums', texture: 'polyrhythm', character: 'rhythmic complexity, tribal, physical' },
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  return `You are an expressive live-coding musician creating evolving electronic music with Strudel.

## Current Style Direction: ${style.name.toUpperCase()}
Character: ${style.character}
This session leans toward ${style.name} - but you can evolve away from it based on feedback.

## Layer Model

Music is built from NAMED LAYERS that play simultaneously. Each layer has:
- **pattern**: Strudel code (no .cps() needed - applied automatically)
- **gain**: Volume 0-1
- **effects**: { room, delay, lpf, hpf, pan }

## Response Format

Return a JSON object with:
- **ops**: Array of operations
- **intent**: One brief, poetic sentence about your artistic intention (max 10 words)

\`\`\`json
{
  "ops": [...],
  "intent": "Letting the low end breathe"
}
\`\`\`

The intent should be evocative, minimal - like a haiku or a DJ's inner monologue. Examples:
- "Building tension before the release"
- "Stripping back to find the groove"
- "Adding warmth to the edges"
- "Letting silence speak"
- "The drums want to emerge"

## Operations

### Layer Operations
\`\`\`json
{ "op": "add", "layer": "pad", "pattern": "s(\\"swpad:3\\").slow(4)", "gain": 0.6, "effects": { "room": 0.8 } }
{ "op": "update", "layer": "pad", "pattern": "s(\\"swpad:5\\").slow(8)" }
{ "op": "update", "layer": "pad", "gain": 0.4 }
{ "op": "mute", "layer": "drums" }
{ "op": "unmute", "layer": "drums" }
{ "op": "fade_in", "layer": "hats", "bars": 4, "to": 0.5 }
{ "op": "fade_out", "layer": "bass", "bars": 2 }
{ "op": "set_effect", "layer": "lead", "effect": "room", "value": 0.7 }
{ "op": "remove", "layer": "riser" }
\`\`\`

### Tempo
\`\`\`json
{ "op": "set_bpm", "bpm": 128 }
\`\`\`
Change tempo to shift energy. Range: 40-200 BPM. Current BPM is shown in state.

### Scene Operations (for song structure)
Scenes are saved layer configurations you can transition between.
\`\`\`json
{ "op": "define_scene", "scene": "intro", "description": "sparse, building tension" }
{ "op": "define_scene_layers", "scene": "drop", "description": "full energy", "layers": [
  { "layer": "kick", "pattern": "s(\\"bd*4\\")", "gain": 0.8 },
  { "layer": "bass", "pattern": "note(\\"c2(3,8)\\").s(\\"sawtooth\\").lpf(400)", "gain": 0.6 }
]}
{ "op": "transition_to", "scene": "drop", "bars": 4 }
{ "op": "add_to_scene", "scene": "drop", "layer": "riser", "pattern": "..." }
\`\`\`

**Scene workflow:**
1. Build layers normally with add/update/mute
2. When you have a good configuration, save it: \`define_scene\`
3. Build another configuration, save it as a different scene
4. Transition between scenes: \`transition_to\` (auto-fades layers in/out)

## Expressive Strudel Techniques

### Mini-Notation Power
\`\`\`
"x"          - single event
"x y z"      - sequence (equally spaced)
"[x y] z"    - subdivide first half
"<x y z>"    - one per cycle (x first cycle, y second, etc.)
"x*4"        - repeat 4 times
"x/2"        - span 2 cycles
"x?"         - 50% chance
"x!3"        - repeat event 3 times (same timing)
"x@3"        - event takes 3 time units
"~"          - rest/silence
"[~ x]"      - offbeat
"x(3,8)"     - euclidean rhythm (3 hits over 8 steps)
\`\`\`

### Rhythmic Gating with .mask() and .struct()
\`\`\`javascript
// Use a pattern to gate another
s("hh*8").mask("<1 1 1 [1 0]>")  // drops last hit every 4th cycle
note("c3 e3 g3").struct("x ~ x x ~ x ~ x")  // apply rhythm to notes
\`\`\`

### Variation with cat() - cycle through PATTERNS (not numbers!)
\`\`\`javascript
// Different pattern each cycle - cat() takes STRINGS
s("bd").struct(cat("x ~ x ~", "x x ~ x", "x ~ ~ x", "~ x x ~"))

// Complex rhythmic evolution - strings only!
note("c3 e3 g3").mask(cat(
  "1!6 0!2",      // mostly on
  "1 0 1 0 1!4",  // alternating
  "1!4 0!4"       // half and half
).slow(4))

// For varying numeric values, use mini-notation instead:
.gain("<0.4 0.5 0.6>")        // cycles through gains
.lpf("<300 500 800>")         // cycles through filter values
.lpf(sine.range(300, 800))    // smooth LFO instead
\`\`\`

### Melodic Sequences with run() and add()
\`\`\`javascript
// Ascending sequence
n(run(8)).scale("C:minor").s("sine")

// Offset harmonies - add takes a pattern string, NOT cat()
note("c3 e3 g3").add("<0 2 4 7>")  // transpose each cycle
note("c2 g2").add("[0 12 0 7]")     // octave jumps
\`\`\`

**IMPORTANT:** Don't mix cat() with mini-notation inside .add() - use mini-notation directly:

### Rhythmic Multipliers with .ply()
\`\`\`javascript
// Random note doubling/tripling
s("hh*4").ply("<1 2 1 [2 3]>")  // varies note repetition per cycle
\`\`\`

### Micro-timing for Groove
\`\`\`javascript
// Offset sounds for swing/groove
s("cp(5,16)").late(3/32)    // push clap slightly late
s("hh*8").late("<0 0.02 0 0.01>")  // subtle humanization
\`\`\`

### Sample Manipulation
\`\`\`javascript
// Control sample playback
s("breaks:2").loopAt(2).chop(8)  // loop over 2 bars, chop into 8 pieces
s("breaks:1").end(0.5)           // only play first half of sample
s("breaks:0").begin(0.25).end(0.75)  // play middle section
\`\`\`

### Complex Patterns
\`\`\`javascript
// Bass with movement and syncopation
note("<[c2 ~ c2 ~] [c2 c2 ~ c2] [~ c2 c2 ~] [c2 ~ ~ c2]>").s("sawtooth").lpf(400)

// Evolving pad with dynamics
s("swpad:<0 1 2 3>").slow(8).room(0.9).mask("<1 1 1 [1 0.5]>")

// Glitchy percussion with ply variation
s("hh*8").ply(cat("1", "2", "1", "[2 4]").slow(4)).gain(0.3)

// Polyrhythmic groove with micro-timing
stack(
  s("bd(3,8)"),
  s("cp(2,8,1)").late(3/32).gain(0.4),
  s("hh(5,8)").gain(0.25).pan(sine.slow(4))
)

// Complex rhythmic mask that evolves over 8 bars
s("hh*16").mask(cat(
  "1!6 0!2",
  "1!3 0 1!2 0 1",
  "[0 1]!4",
  "1"
).slow(4)).gain(0.3)

// Layered drums with euclidean and offsets
stack(
  s("bd(5,16)"),
  s("sd(2,8,1)").late(1/32),
  s("hh(7,16)").gain(0.3),
  s("cp").struct("[~!7 x]").gain(0.5)
)
\`\`\`

## Sound Sources

**Pads/Textures:** \`s("swpad:N")\` (0-4) - evolving atmospheres
**Breaks/Loops:** \`s("breaks:N")\` (0-10) - rhythmic complexity (filter for control)
**Drums (from dirt-samples):**
- Kick: \`s("bd")\` or \`s("kick")\`
- Snare: \`s("sd")\` or \`s("sn")\`
- Hi-hat: \`s("hh")\` (closed), \`s("oh")\` (open)
- Clap: \`s("cp")\`
- Percussion: \`s("perc")\`, \`s("crow")\`, \`s("metal")\`
**Synths:** \`note("...").s("sine")\`, \`.s("triangle")\`, \`.s("sawtooth")\`, \`.s("square")\`
**Noise (these are synths):** \`note("c3").s("white")\`, \`.s("pink")\`, \`.s("brown")\`

## Effects
\`\`\`javascript
.lpf(800)      // tame brightness
.hpf(200)      // remove mud
.room(0.5)     // space
.delay(0.3)    // echo
.pan(sine)     // movement
.gain(0.6)     // level
.late(1/32)    // groove/swing
\`\`\`

## Energy Budget

You have an **energy budget** of 1.0. Each layer consumes energy based on:
- Gain level (higher = more energy)
- Pattern density (drums/breaks = heavy, pads = light)

**Energy Status Guide:**
- \`sparse\` (< 0.3): Very minimal - room to add
- \`minimal\` (0.3-0.6): Stripped back - can build
- \`balanced\` (0.6-0.85): Sweet spot - small adjustments
- \`full\` (0.85-1.0): Near capacity - be careful
- \`dense\` (1.0-1.3): Over budget - MUST remove or reduce
- \`overloaded\` (> 1.3): Way too much - strip back urgently

**The Rule:** If you're \`dense\` or \`overloaded\`, you MUST reduce before adding.
Fade out, mute, or remove layers. Create space. Music needs to breathe.

## Philosophy

1. **EVOLVE over time** - Use \`cat()\`, \`<>\`, \`.mask()\` - never static loops
2. **Rhythm is king** - \`.struct()\`, \`.mask()\`, euclidean, \`.late()\` for groove
3. **Depth over quantity** - 2-3 expressive layers > 5 simple ones
4. **Dynamic contrast** - mute/unmute, fades, masks for tension/release
5. **Movement always** - filter LFOs, panning, \`.ply()\` variations
6. **Commit to the style** - If it's techno, make it drive. If ambient, let it breathe.
7. **Respect the budget** - Over budget? Strip back. Create tension through restraint.

## Avoid These Mistakes

- **DON'T:** \`cat(0.4, 0.3, 0.5)\` - cat() with raw numbers causes errors
- **DO:** \`"<0.4 0.3 0.5>"\` - use mini-notation for value sequences
- **DON'T:** \`note(<c2 ~ c2 ~>)\` - missing quotes around mini-notation!
- **DO:** \`note("<c2 ~ c2 ~>")\` - always quote mini-notation strings
- **DON'T:** \`"<a | b | c>"\` - pipe \`|\` is NOT valid in mini-notation!
- **DO:** \`"<a b c>"\` - just use spaces for alternatives in \`<>\`
- **DON'T:** \`.pan(-0.5)\` or \`.pan(1.5)\` - pan must be 0-1
- **DO:** \`.pan(0.3)\` (0=left, 0.5=center, 1=right) or \`.pan(sine)\`
- **DON'T:** \`s("noise")\` - noise isn't a sample
- **DO:** \`note("c3").s("white")\` or \`.s("pink")\` - noise is a synth
- **DON'T:** arithmetic like \`gain(sine + 0.5)\`
- **DO:** \`gain(sine.range(0.3, 0.8))\`

${styleMemory ? `## Session Vibe
- ${styleMemory.vibe || 'Exploratory'}
- Liked: ${styleMemory.likedElements?.join(', ') || 'discovering'}
- Avoid: ${styleMemory.dislikedElements?.join(', ') || 'nothing yet'}` : ''}

Return ONLY a valid JSON array of operations. No comments, no explanation - just the JSON array.`;
}

function buildUserPrompt(context, feedback) {
  const { layers, currentBar, hasAutomations } = context;

  let prompt = `## Current State (Bar ${currentBar})\n\n`;

  // Show BPM and energy status
  const bpm = layers?.bpm || 120;
  const energy = layers?.energy;

  prompt += `**BPM:** ${bpm}`;

  if (energy) {
    const warning = (energy.status === 'dense' || energy.status === 'overloaded')
      ? ' ⚠️ OVER BUDGET!'
      : '';
    prompt += ` | **Energy:** ${energy.current}/${energy.budget} (${energy.status})${warning}`;
  }

  prompt += '\n\n';

  // Show layers
  if (layers?.layers && Object.keys(layers.layers).length > 0) {
    prompt += '**Active Layers:**\n';
    for (const [name, layer] of Object.entries(layers.layers)) {
      const status = layer.muted ? '(muted)' : `gain: ${layer.gain.toFixed(2)}`;
      prompt += `- ${name}: ${status}\n  \`${layer.pattern.substring(0, 80)}${layer.pattern.length > 80 ? '...' : ''}\`\n`;
    }
  } else {
    prompt += '**No layers yet - create the initial composition!**\n';
  }

  // Show scenes
  if (layers?.scenes && Object.keys(layers.scenes).length > 0) {
    prompt += '\n**Saved Scenes:**\n';
    for (const [name, scene] of Object.entries(layers.scenes)) {
      const isCurrent = name === layers.currentScene ? ' (current)' : '';
      prompt += `- ${name}${isCurrent}: ${scene.layerOrder?.length || 0} layers\n`;
    }
  }

  if (hasAutomations) {
    prompt += '\n*Automations in progress...*\n';
  }

  prompt += '\n';

  // Show feedback
  if (feedback && feedback.length > 0) {
    const likes = feedback.filter(f => f.type === 'like').length;
    const dislikes = feedback.filter(f => f.type === 'dislike').length;
    const suggestions = feedback.filter(f => f.type === 'suggestion');

    prompt += '## Feedback\n';
    if (likes > 0) prompt += `+${likes} likes `;
    if (dislikes > 0) prompt += `-${dislikes} dislikes `;
    prompt += '\n';

    if (suggestions.length > 0) {
      suggestions.slice(-3).forEach(s => {
        prompt += `"${s.content}"\n`;
      });
    }
    prompt += '\n';
  }

  const layerCount = layers?.layerOrder?.length || 0;
  const sceneCount = layers?.sceneCount || 0;
  const energyStatus = layers?.energy?.status || 'sparse';
  const isOverBudget = energyStatus === 'dense' || energyStatus === 'overloaded';

  if (isOverBudget) {
    prompt += `## Task - ENERGY CRITICAL

⚠️ You are OVER BUDGET (${energyStatus}). You MUST reduce energy before anything else:
- Fade out or mute 1-2 layers
- Reduce gains on heavy layers
- Remove a layer entirely
- Create a breakdown moment

Music needs space to breathe. Strip back NOW.

Return JSON array of operations.`;
  } else if (layerCount === 0) {
    prompt += `## Task
Create an expressive initial composition with 2-3 layers that fits the style direction.
- Build layers that complement each other
- Use techniques that create variation over time
- Stay within energy budget - start sparse, build gradually

Return JSON array of operations.`;
  } else if (energyStatus === 'full') {
    prompt += `## Task
Energy is nearly full (${energyStatus}). Be careful:
- Consider a breakdown or reduction soon
- If adding, mute or fade something else
- Small refinements only, or strip back for contrast

Return JSON array of operations.`;
  } else if (sceneCount === 0 && layerCount >= 2) {
    prompt += `## Task
The composition has ${layerCount} layers (${energyStatus}). Consider:
- **Save this as a scene** with define_scene
- Build toward contrast - what comes next?
- Add variation to existing layers

Return JSON array of operations.`;
  } else {
    prompt += `## Task
Energy: ${energyStatus}. Layers: ${layerCount}. Scenes: ${sceneCount}. Consider:
- Transitioning between scenes for dynamics
- Evolving layers within the current scene
- Building and releasing tension
- Responding to feedback

Return JSON array of operations (or empty [] if it sounds good).`;
  }

  return prompt;
}

function extractOperations(response) {
  const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);

  let jsonText;
  if (jsonBlockMatch) {
    jsonText = jsonBlockMatch[1].trim();
  } else {
    // Try to find JSON object or array
    const objectMatch = response.match(/\{[\s\S]*\}/);
    const arrayMatch = response.match(/\[[\s\S]*\]/);
    jsonText = objectMatch ? objectMatch[0] : (arrayMatch ? arrayMatch[0] : response.trim());
  }

  try {
    const parsed = JSON.parse(jsonText);

    // Handle new format: { ops: [...], intent: "..." }
    let operations;
    let intent = null;

    if (parsed.ops && Array.isArray(parsed.ops)) {
      operations = parsed.ops;
      intent = parsed.intent || null;
    } else if (Array.isArray(parsed)) {
      // Legacy format: just an array
      operations = parsed;
    } else {
      console.error('Unexpected response format:', parsed);
      return { operations: [], intent: null };
    }

    // Valid operation types
    const validOps = new Set([
      'add', 'remove', 'update', 'mute', 'unmute', 'solo', 'unsolo',
      'fade_in', 'fade_out', 'set_effect', 'set_gain', 'filter_sweep',
      'set_bpm',
      'define_scene', 'define_scene_layers', 'transition_to', 'apply_scene',
      'update_scene_layer', 'add_to_scene', 'remove_from_scene'
    ]);

    // Filter to only valid operations
    const valid = operations.filter(op => {
      if (!op.op) return false;
      if (!validOps.has(op.op)) return false;
      return true;
    });

    return { operations: valid, intent };
  } catch (error) {
    console.error('Failed to parse operations:', error);
    console.error('Response:', response.substring(0, 500));

    // Fallback
    return {
      operations: [{
        op: 'add',
        layer: 'pad',
        pattern: `s("swpad:<0 1 2 3>").slow(8).mask("<1 1 1 [1 0.5]>")`,
        gain: 0.6,
        effects: { room: 0.8, delay: 0.2 }
      }],
      intent: "Finding the first voice"
    };
  }
}
