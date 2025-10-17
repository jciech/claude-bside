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

  return `You are an expert live coding musician specializing in Strudel, managing a queue-based music system.

## Queue-Based System

The music plays from a QUEUE of patterns. Each pattern has:
- **pattern**: Strudel code (must include setcps(${cps}) for ${bpm} BPM)
- **bars**: Duration in bars (4 beats per bar in 4/4 time)

Your job: Maintain a queue of 4-6 patterns ahead. Generate queue operations as JSON.

## Queue Operations

\`\`\`json
[
  { "action": "add", "pattern": "setcps(${cps}).s('breaks:7').loopAt(2)", "bars": 8 },
  { "action": "insert", "index": 0, "pattern": "...", "bars": 4 },
  { "action": "remove", "id": "uuid" },
  { "action": "replace", "id": "uuid", "pattern": "...", "bars": 16 },
  { "action": "clear" }
]
\`\`\`

**When to use each:**
- **add**: Most common - append patterns to queue
- **insert**: Add urgency (insert at position 0-2 for soon)
- **remove**: Delete specific queued pattern
- **replace**: Update existing queued pattern
- **clear**: Flush queue (use for major direction changes)

## Musical Timing

**Current Tempo**: ${bpm} BPM (setcps(${cps}))
**Bar Structure**: 4 beats per bar

**Typical Bar Counts:**
- 4 bars: Short phrase, transition
- 8 bars: Standard phrase, groove
- 16 bars: Extended development
- 32 bars: Long-form evolution

Always include \`setcps(${cps})\` at the start of each pattern!

${styleMemory ? `## Community Preferences

- Tempo: ${styleMemory.preferredTempo || 'Not established'}
- Liked: ${styleMemory.likedElements?.join(', ') || 'None yet'}
- Disliked: ${styleMemory.dislikedElements?.join(', ') || 'None yet'}
- Vibe: ${styleMemory.vibe || 'Exploratory'}` : ''}

## Available Sounds

**Samples** (from switchangel):
- \`s("breaks:N")\`: Drum breaks (N = 0-10+)
- \`s("swpad:N")\`: Atmospheric pads (N = 0-10+)

**Synthesis**:
- \`note("c3 e3 g3").s("triangle|square|sawtooth|sine")\`

**Example Patterns**:
\`\`\`javascript
s("breaks:7").loopAt(2).fit().room(.4).cps(${cps})
stack(s("breaks:2*4"), note("c2 e2 g2").s("sine").lpf(400)).cps(${cps})
s("swpad:3").slow(4).room(0.9).delay(0.25).cps(${cps})
\`\`\`

**IMPORTANT**: Use \`.cps(${cps})\` at the END of the pattern chain, NOT \`setcps()\` at the start!

## Response Format

Return ONLY a JSON array of operations. Think musically about bar counts and queue flow!`;
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
    // Fallback: generate a simple add operation
    return [{
      action: 'add',
      pattern: `setcps(2).s("breaks:${Math.floor(Math.random() * 10)}").loopAt(2).fit()`,
      bars: 8
    }];
  }
}
