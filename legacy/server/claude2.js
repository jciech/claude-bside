import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Generate a target state from Claude
 */
export async function generateTarget(context, feedback, styleHint) {
  const systemPrompt = buildSystemPrompt(styleHint);
  const userPrompt = buildUserPrompt(context, feedback);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
    });

    const response = message.content[0].text;
    return parseResponse(response);
  } catch (error) {
    console.error('Error generating target:', error);
    throw error;
  }
}

function buildSystemPrompt(styleHint) {
  const style = styleHint || { name: 'electronic', character: 'evolving, expressive' };

  return `You are an expressive live-coding musician creating ${style.name} music.

## How It Works

You control music by describing the **target state** you want. The system smoothly transitions to it.

## Response Format

Return a JSON object:
\`\`\`json
{
  "target": {
    "voiceName": { "pattern": "strudel code", "level": 0.0-1.0 },
    "otherVoice": 0.5
  },
  "over": 4,
  "bpm": 120,
  "intent": "Brief poetic description"
}
\`\`\`

- **target**: Voices and their desired state
  - Full form: \`{ "pattern": "...", "level": 0.7 }\`
  - Just level: \`0.7\` (keeps current pattern)
  - Level 0 = fade out, new voices start at 0 and fade in
- **over**: Bars to transition (levels interpolate, patterns change instantly)
- **bpm**: Optional tempo (40-200)
- **intent**: Your artistic intention (max 8 words)

## Strudel Patterns

Each voice is a Strudel pattern string. ALL strings must be quoted!

\`\`\`javascript
// Drums - note the quotes around ALL mini-notation
s("bd(3,8)")
s("hh*8").mask("<1!6 0!2>").gain(0.4)
s("cp").struct("[~!7 x]")

// Bass - quotes around the note pattern!
note("<c2 eb2 g2>").s("sawtooth").lpf(400)

// Texture
s("swpad:3").slow(8).room(0.8).delay(0.3)

// Melody - quotes!
note("<[c4 e4] [e4 g4] [g4 c5]>").s("triangle").decay(0.3)

// Noise (synth, not sample!)
note("c3").s("white").lpf(2000)
\`\`\`

**Remember:** \`note("<c2>")\` NOT \`note(<c2>)\`

## Mini-Notation
\`\`\`
"x y z"     - sequence
"<x y z>"   - one per cycle
"[x y] z"   - subdivide
"x*4"       - repeat
"x?"        - 50% chance
"~"         - rest
"x(3,8)"    - euclidean
"x!4"       - replicate
\`\`\`

## Key Functions
- \`.slow(n)\` / \`.fast(n)\` - tempo
- \`.gain(n)\` - volume (0-1)
- \`.room(n)\` - reverb
- \`.delay(n)\` - echo
- \`.lpf(n)\` / \`.hpf(n)\` - filters
- \`.mask("pattern")\` - rhythmic gating
- \`.struct("pattern")\` - apply rhythm
- \`.late(n)\` - timing offset

## Energy Budget

Current energy status is shown in state.
- \`sparse\` / \`minimal\`: Room to build
- \`balanced\` / \`full\`: Good place to be
- \`dense\`: Getting full - consider balance, but don't panic
- \`overloaded\`: Time to pull something back gently

## Philosophy

1. **Transitions are the music** - Think about the journey, not just the destination
2. **Let voices take turns shining** - Don't keep everything balanced:
   - Sometimes the melody leads (raise melody, lower bass/drums)
   - Sometimes the bass drives (simplify melody, boost bass)
   - Sometimes rhythm takes over (strip melody, emphasize groove)
   - Then shift the spotlight to something else
3. **Simplify to emphasize** - A simple, sustained melody note can be powerful when the bass is busy. A busy melody works when the bass is simple.
4. **Create contrast** - If the melody has been complex, make it simple for a while. If bass has been subtle, let it take center stage.
5. **Less is more** - 2-3 voices where one leads > 5 voices competing
6. **Everything moves** - Use \`<>\`, \`.mask()\`, \`.slow()\` for evolution

## ⚠️ SYNTAX RULES - READ CAREFULLY ⚠️

**ALL arguments to note(), s(), n() MUST be quoted strings:**

CORRECT:
\`\`\`
note("<c2 eb2 g2>")     ← quotes around pattern
note("[c2 eb2] g2")     ← quotes around pattern
s("bd(3,8)")            ← quotes around pattern
s("hh*8")               ← quotes around pattern
\`\`\`

WRONG (will crash):
\`\`\`
note(<c2 eb2 g2>)       ← NO QUOTES = CRASH
note(c2 eb2 g2)         ← NO QUOTES = CRASH
s(bd(3,8))              ← NO QUOTES = CRASH
\`\`\`

**Other rules:**
- NO pipe \`|\` in patterns - use spaces: \`"<a b c>"\` not \`"<a|b|c>"\`
- NO \`s("noise")\` - use \`note("c3").s("white")\`
- Pan is 0-1: \`.pan(0.3)\` not \`.pan(-0.5)\`

Return ONLY valid JSON. No explanation outside the JSON.`;
}

function buildUserPrompt(context, feedback) {
  const { state, bar } = context;

  let prompt = `## Current State (Bar ${bar})\n\n`;

  // Show BPM and energy
  prompt += `**BPM:** ${state.bpm}`;
  if (state.energy) {
    const warning = (state.energy.status === 'dense' || state.energy.status === 'overloaded')
      ? ' ⚠️ OVER BUDGET!'
      : '';
    prompt += ` | **Energy:** ${state.energy.current}/${state.energy.budget} (${state.energy.status})${warning}`;
  }
  prompt += '\n\n';

  // Show voices
  const voices = state.voices || {};
  const voiceNames = Object.keys(voices);

  if (voiceNames.length > 0) {
    prompt += '**Voices:**\n';
    for (const name of voiceNames) {
      const v = voices[name];
      const levelStr = v.transitioning ? `${v.level}→${v.target}` : `${v.level}`;
      const patternPreview = v.pattern.length > 60 ? v.pattern.substring(0, 60) + '...' : v.pattern;
      prompt += `- ${name} [${levelStr}]: \`${patternPreview}\`\n`;
    }
  } else {
    prompt += '**No voices yet - create the initial composition!**\n';
  }

  if (state.transitioning) {
    prompt += '\n*Transitions in progress...*\n';
  }

  prompt += '\n';

  // Show feedback
  if (feedback && feedback.length > 0) {
    const likes = feedback.filter(f => f.type === 'like').length;
    const dislikes = feedback.filter(f => f.type === 'dislike').length;
    const suggestions = feedback.filter(f => f.type === 'suggestion');

    prompt += '## Feedback\n';
    if (likes > 0) prompt += `+${likes} likes `;
    if (dislikes > 0) prompt += `-${dislikes} dislikes`;
    prompt += '\n';

    if (suggestions.length > 0) {
      suggestions.slice(-3).forEach(s => {
        prompt += `"${s.content}"\n`;
      });
    }
    prompt += '\n';
  }

  // Task based on state
  const voiceCount = voiceNames.length;
  const energyStatus = state.energy?.status || 'sparse';

  if (voiceCount === 0) {
    prompt += `## Task

Create the initial composition:
- Start with 2-3 complementary voices
- Use expressive patterns with movement
- Set levels between 0.4-0.8 (leave headroom)

Return your target state.`;
  } else if (energyStatus === 'overloaded') {
    prompt += `## Task

Energy is high (${energyStatus}). Consider:
- Lowering one or two voice levels (don't remove everything!)
- Keep the core groove, just create some space
- This is a musical choice, not an emergency

Return your target state.`;
  } else if (voiceCount < 3 && energyStatus !== 'dense') {
    prompt += `## Task

Build on the current ${voiceCount} voice(s) (${energyStatus}):
- Add a complementary voice, OR
- Evolve an existing pattern, OR
- Adjust levels for better balance

Return your target state.`;
  } else {
    prompt += `## Task

The composition has ${voiceCount} voices (${energyStatus}). Consider:
- **Who should lead right now?** Raise one voice, lower others
- Simplify the melody and let the bass shine, or vice versa
- If everything's been balanced, create contrast - let something dominate briefly
- Evolving a pattern while changing the balance

Think: What hasn't had the spotlight lately?

Return your target state.`;
  }

  return prompt;
}

function parseResponse(response) {
  // Try to extract JSON from code block
  const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);

  let jsonText;
  if (jsonBlockMatch) {
    jsonText = jsonBlockMatch[1].trim();
  } else {
    // Try to find JSON object
    const objectMatch = response.match(/\{[\s\S]*\}/);
    jsonText = objectMatch ? objectMatch[0] : response.trim();
  }

  try {
    const parsed = JSON.parse(jsonText);

    // Validate structure
    if (!parsed.target || typeof parsed.target !== 'object') {
      console.warn('Response missing target object');
      return {
        target: {
          texture: { pattern: 's("swpad:3").slow(8).room(0.8)', level: 0.6 }
        },
        over: 4,
        intent: 'Finding the first voice'
      };
    }

    return {
      target: parsed.target,
      over: parsed.over ?? 4,
      bpm: parsed.bpm,
      intent: parsed.intent || null
    };
  } catch (error) {
    console.error('Failed to parse response:', error);
    console.error('Response:', response.substring(0, 500));

    // Fallback
    return {
      target: {
        texture: { pattern: 's("swpad:3").slow(8).room(0.8)', level: 0.6 }
      },
      over: 4,
      intent: 'Starting fresh'
    };
  }
}
