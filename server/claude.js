import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Generate queue operations based on context and feedback
 * @param {Object} context - Current musical context including queue
 * @param {Array} feedback - Recent feedback from users
 * @param {Object} styleMemory - Learned style preferences
 * @returns {Promise<Array>} - Array of queue operations
 */
export async function generateQueueOperations(context, feedback, styleMemory) {
  const systemPrompt = buildSystemPrompt(styleMemory, context.tempo);
  const userPrompt = buildUserPrompt(context, feedback);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ],
    });

    // Extract queue operations from the response
    const response = message.content[0].text;
    const operations = extractQueueOperations(response);

    return operations;
  } catch (error) {
    console.error('Error generating queue operations:', error);
    throw error;
  }
}

/**
 * Build the system prompt for Claude
 */
function buildSystemPrompt(styleMemory, tempo) {
  const bpm = tempo?.bpm || 120;
  const cps = (bpm / 60).toFixed(2);

  return `You are an expert live coding musician creating groovy, layered electronic music with Strudel.

## Your Role

You manage a QUEUE of patterns for continuous playback. Each pattern needs:
- **pattern**: Valid Strudel code ending with .cps(${cps})
- **bars**: Duration (4, 8, 16, or 32 bars)

Generate queue operations as a JSON array.

## Queue Operations

\`\`\`json
[
  { "action": "add", "pattern": "...", "bars": 8 },
  { "action": "clear" }
]
\`\`\`

Actions: add (append), insert (with index), remove (by id), replace (by id), clear

## Mini-Notation (Essential)

**Rhythm:**
- Space = sequence: \`"c d e f"\` (4 equal events per cycle)
- \`*N\` = faster: \`"hh*8"\` (8 hi-hats per cycle)
- \`/N\` = slower: \`"chord/4"\` (stretches over 4 cycles)
- \`[]\` = subdivide: \`"[bd sd] hh"\` (bd+sd share first half)
- \`<>\` = alternate per cycle: \`"<c e g>"\` (c first cycle, e second, etc.)
- \`~\` = rest: \`"bd ~ sd ~"\`
- \`?\` = 50% chance: \`"hh*8?"\` (randomly drops some)
- \`,\` = stack/chord: \`"[c3,e3,g3]"\` (simultaneous)

**Euclidean Rhythms** (these sound GREAT):
- \`(3,8)\` = Cuban tresillo: \`"bd(3,8)"\`
- \`(5,8)\` = cinquillo: \`"hh(5,8)"\`
- \`(3,4)\` = cumbia: \`"sd(3,4)"\`
- \`(7,16)\` = West African bell

## Sonic Palette

**Soft / Warm** (use freely, these breathe):
- \`swpad\`: Ethereal, dreamy textures - beautiful as foundations
- \`sine\`, \`triangle\`: Gentle, round - lovely for pads, soft bass, melodies
- Effects like \`.room()\` and \`.delay()\` add space and warmth

**Bright / Present** (use with care):
- \`sawtooth\`, \`square\`: Cutting, buzzy - tame with \`.lpf(400-1000)\`
- \`hh\`, \`cp\`: Can get harsh at high density - keep sparse or lower gain

**Heavy / Aggressive** (use sparingly):
- \`breaks\`: Full of energy but can overwhelm - always use \`.gain(0.3-0.5)\` and \`.lpf(800-2000)\` to sit back in mix
- \`bd\`, \`sd\`: Punchy, can hollow out the sound - leave space between hits

**Balance**: Favor soft textures. A good pattern might be 60% warm/textural, 30% rhythmic, 10% accent. When in doubt, less is more.

## Sound Sources

**Samples:**
- \`s("breaks:N")\` - Drum breaks (0-10) - **filter and reduce gain!**
- \`s("swpad:N")\` - Atmospheric pads (0-10) - these are your friends

**Drums (mini-notation):**
- \`s("bd")\` kick, \`s("sd")\` snare, \`s("hh")\` hi-hat, \`s("cp")\` clap, \`s("oh")\` open hat

**Synths:**
- \`note("c2 e2 g2").s("sawtooth")\` - saw, sine, triangle, square
- Prefer \`sine\` and \`triangle\` for warmth; filter \`sawtooth\` heavily

## Essential Functions

**Layering (USE THIS!):**
- \`stack(pattern1, pattern2, ...)\` - Play patterns simultaneously

**Variation:**
- \`.jux(rev)\` - Stereo split, right channel reversed
- \`.sometimes(func)\` - Apply function 50% of the time
- \`.every(N, func)\` - Apply function every N cycles
- \`.off(time, func)\` - Delayed copy with transformation

**Effects:**
- \`.lpf(freq)\` - Low-pass filter (200-8000)
- \`.room(amt)\` - Reverb (0-1)
- \`.delay(amt)\` - Delay (0-1)
- \`.gain(amt)\` - Volume (0-1)
- \`.pan(pos)\` - Stereo (0=left, 1=right)

**Filter Modulation (makes it alive!):**
- \`.lpf(sine.range(400,2000).slow(8))\` - Sweeping filter

**Time:**
- \`.slow(N)\` / \`.fast(N)\` - Time stretch
- \`.loopAt(N).fit()\` - Fit sample to N bars

## Pattern Recipes

**Warm Ambient (soft foundation):**
\`\`\`javascript
stack(
  s("swpad:3").slow(4).room(0.8).gain(0.6),
  note("[c3,e3,g3]/2").s("triangle").lpf(sine.range(600,2000).slow(16)).room(0.5),
  s("hh(3,8)").gain(0.15).delay(0.4)
).cps(${cps})
\`\`\`

**Gentle Groove (texture + subtle rhythm):**
\`\`\`javascript
stack(
  s("swpad:5").slow(8).room(0.7).gain(0.5),
  note("<c2 ~ bb1 ~>").s("sine").lpf(300).decay(0.2),
  s("bd(3,8)").gain(0.5),
  s("hh*4?").gain(0.2).pan(sine.range(0.3,0.7))
).cps(${cps})
\`\`\`

**Melodic Drift:**
\`\`\`javascript
stack(
  note("<[c3 e3] [e3 g3] [g3 c4] [e3 c3]>").s("triangle").decay(0.3).room(0.6).delay(0.25),
  note("c2(3,8)").s("sine").lpf(400).gain(0.6),
  s("swpad:2").slow(8).gain(0.4).room(0.9)
).cps(${cps})
\`\`\`

**With Breaks (tamed):**
\`\`\`javascript
stack(
  s("swpad:4").slow(4).room(0.8).gain(0.6),
  s("breaks:3").loopAt(4).fit().lpf(1200).gain(0.35).room(0.4),
  note("c2 ~ c2 eb2").s("triangle").lpf(500).gain(0.5)
).cps(${cps})
\`\`\`

${styleMemory ? `## Community Feedback

- Vibe: ${styleMemory.vibe || 'Exploratory'}
- Liked: ${styleMemory.likedElements?.join(', ') || 'None yet'}
- Avoid: ${styleMemory.dislikedElements?.join(', ') || 'None yet'}
${styleMemory.topPatterns?.length > 0 ? `
**Crowd favorites** (build on these):
${styleMemory.topPatterns.map(p => `- +${p.score}: \`${p.code.substring(0, 80)}...\``).join('\n')}` : ''}
${styleMemory.bottomPatterns?.length > 0 ? `
**Didn't work** (avoid similar):
${styleMemory.bottomPatterns.map(p => `- ${p.score}: \`${p.code.substring(0, 80)}...\``).join('\n')}` : ''}` : ''}

## Guidelines

1. **Lead with texture** - Start from swpad or soft synths, add rhythm gently
2. **Less is more** - 2-3 well-balanced layers beats 5 competing ones
3. **Filter everything bright** - sawtooth needs .lpf(400-800), breaks need .lpf(800-1500)
4. **Keep gains low** - breaks: 0.3-0.4, drums: 0.4-0.6, pads: 0.5-0.7
5. **Use space** - .room() and .delay() create depth and warmth
6. **End every pattern with .cps(${cps})**

Return ONLY a JSON array of queue operations.`;
}

/**
 * Build the user prompt with context and feedback
 */
function buildUserPrompt(context, feedback) {
  const { currentPattern, queue, queueLength, targetQueueLength, tempo } = context;

  let prompt = `## Current State

**Now Playing**: ${currentPattern.bars} bars
\`\`\`javascript
${currentPattern.pattern}
\`\`\`

**Queue**: ${queueLength} patterns (target: ${targetQueueLength})
`;

  if (queue && queue.length > 0) {
    prompt += '\nQueued patterns:\n';
    queue.forEach((p, i) => {
      const preview = p.pattern.substring(0, 60);
      prompt += `${i + 1}. ${p.bars} bars - ${preview}...\n`;
    });
  } else {
    prompt += '(Queue is empty - needs patterns!)\n';
  }

  prompt += '\n';

  if (feedback && feedback.length > 0) {
    prompt += `## Recent Feedback (${feedback.length} items)\n\n`;

    const likes = feedback.filter(f => f.type === 'like').length;
    const dislikes = feedback.filter(f => f.type === 'dislike').length;
    const suggestions = feedback.filter(f => f.type === 'suggestion');

    if (likes > 0) prompt += `👍 ${likes} likes\n`;
    if (dislikes > 0) prompt += `👎 ${dislikes} dislikes\n`;

    if (suggestions.length > 0) {
      prompt += `\n💡 Suggestions:\n`;
      suggestions.forEach(s => {
        prompt += `- "${s.content}"\n`;
      });
    }

    prompt += '\n';
  }

  // Generate appropriate instructions based on queue state
  const needsPatterns = queueLength < targetQueueLength;
  const patternsNeeded = targetQueueLength - queueLength;

  if (needsPatterns) {
    prompt += `## Task\n\nQueue needs ${patternsNeeded} more pattern(s).\n\n`;

    if (queueLength === 0) {
      prompt += `Generate ${targetQueueLength} patterns to fill the queue. Consider:\n`;
      prompt += `- Musical progression and flow\n`;
      prompt += `- Variety in bar lengths (4, 8, 16 bars)\n`;
      prompt += `- Build energy and interest over time\n`;
    } else {
      prompt += `Add ${patternsNeeded} pattern(s) that continue the musical journey.\n`;
    }

    if (feedback && feedback.length > 0) {
      prompt += `\nIncorporate the feedback into your new patterns!\n`;
    }
  } else {
    prompt += `## Task\n\nQueue is healthy (${queueLength} patterns). `;

    if (feedback && feedback.length > 0) {
      prompt += `Consider feedback - should you modify the queue?\n`;
      prompt += `- Strong positive feedback: Keep current direction\n`;
      prompt += `- Negative feedback or suggestions: Clear and regenerate\n`;
    } else {
      prompt += `No action needed unless you want to refine upcoming patterns.\n`;
    }
  }

  prompt += `\nReturn JSON array of queue operations.`;

  return prompt;
}

/**
 * Extract queue operations from Claude's response
 */
function extractQueueOperations(response) {
  // Try to extract JSON from code block
  const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);

  let jsonText;
  if (jsonBlockMatch) {
    jsonText = jsonBlockMatch[1].trim();
  } else {
    // Try to find JSON array in the response
    const arrayMatch = response.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (arrayMatch) {
      jsonText = arrayMatch[0];
    } else {
      jsonText = response.trim();
    }
  }

  try {
    const operations = JSON.parse(jsonText);

    if (!Array.isArray(operations)) {
      console.error('Operations is not an array:', operations);
      return [];
    }

    // Validate operations
    const validOperations = operations.filter(op => {
      if (!op.action) {
        console.warn('Operation missing action:', op);
        return false;
      }

      if (['add', 'insert'].includes(op.action) && (!op.pattern || !op.bars)) {
        console.warn('Add/insert operation missing pattern or bars:', op);
        return false;
      }

      return true;
    });

    return validOperations;
  } catch (error) {
    console.error('Failed to parse queue operations:', error);
    console.error('Response:', response.substring(0, 500));
    // Fallback: generate a simple add operation (uses default 120 BPM = 2 cps)
    return [{
      action: 'add',
      pattern: `s("breaks:${Math.floor(Math.random() * 10)}").loopAt(2).fit().cps(2)`,
      bars: 8
    }];
  }
}
