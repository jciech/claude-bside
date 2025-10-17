import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Generate a Strudel pattern based on context and feedback
 * @param {Object} context - Current musical context
 * @param {Array} feedback - Recent feedback from users
 * @param {Object} styleMemory - Learned style preferences
 * @returns {Promise<string>} - Generated Strudel code
 */
export async function generatePattern(context, feedback, styleMemory) {
  const systemPrompt = buildSystemPrompt(styleMemory);
  const userPrompt = buildUserPrompt(context, feedback);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ],
    });

    // Extract the Strudel code from the response
    const response = message.content[0].text;
    const strudelCode = extractStrudelCode(response);

    return strudelCode;
  } catch (error) {
    console.error('Error generating pattern:', error);
    throw error;
  }
}

/**
 * Build the system prompt for Claude
 */
function buildSystemPrompt(styleMemory) {
  return `You are an expert live coding musician specializing in Strudel, a JavaScript-based music live coding environment.

Your goal is to create engaging, danceable music patterns that respond to community feedback.

Key principles:
- Generate valid Strudel code that can be immediately evaluated
- Create patterns that evolve gradually, not drastically (unless requested)
- Balance complexity with listenability
- Consider the feedback and learned preferences
- Use Strudel's mini-notation for rhythm patterns
- Experiment with different sounds, effects, and patterns

CRITICAL - Use ONLY Pure Synthesis (NO SAMPLES):
- Use note() with built-in synths: "triangle", "square", "sawtooth", "sine"
- NEVER use sound() - it tries to load samples from the internet
- NEVER use .s() with drum kit names
- Build drum sounds with synthesis: note("<c1 c2>").s("square").lpf(100)
- Use effects: .lpf(), .hpf(), .room(), .delay(), .vowel()
- Combine with stack() to layer parts

${styleMemory ? `Current community preferences:
- Tempo preference: ${styleMemory.preferredTempo || 'Not established yet'}
- Liked elements: ${styleMemory.likedElements?.join(', ') || 'None yet'}
- Disliked elements: ${styleMemory.dislikedElements?.join(', ') || 'None yet'}
- Overall vibe: ${styleMemory.vibe || 'Exploratory'}` : ''}

ONLY USE THESE PATTERNS (synthesized sounds only):
\`\`\`javascript
note("c3 e3 g3 c4").s("triangle").slow(2)
note("<c1 c2 c1 c2>*4").s("square").lpf(200)
stack(note("c1*4").s("square"), note("c4 e4 g4").s("sawtooth").slow(2))
note("c2 e2 g2").s("sine").room(0.5).delay(0.25)
\`\`\`

NEVER use sound() or external samples - ONLY note() + synth names!

Return ONLY the Strudel code, wrapped in a code block. The code should be a single Strudel pattern expression.`;
}

/**
 * Build the user prompt with context and feedback
 */
function buildUserPrompt(context, feedback) {
  const currentPattern = context.currentPattern || 'sound("bd sd")';
  const iterationType = context.iterationType || 'micro-variation';

  let prompt = `Current pattern:
\`\`\`javascript
${currentPattern}
\`\`\`

`;

  if (feedback && feedback.length > 0) {
    prompt += `Recent feedback from ${feedback.length} listener(s):\n`;

    const likes = feedback.filter(f => f.type === 'like').length;
    const dislikes = feedback.filter(f => f.type === 'dislike').length;
    const suggestions = feedback.filter(f => f.type === 'suggestion');

    if (likes > 0) prompt += `- ${likes} likes\n`;
    if (dislikes > 0) prompt += `- ${dislikes} dislikes\n`;

    if (suggestions.length > 0) {
      prompt += `\nSuggestions:\n`;
      suggestions.forEach(s => {
        prompt += `- "${s.content}"\n`;
      });
    }

    prompt += '\n';
  }

  if (iterationType === 'micro-variation') {
    prompt += `Generate a MICRO-VARIATION of the current pattern:
- Keep the same general structure and vibe
- Make small adjustments: slightly different rhythms, add/remove one element, tweak effects
- Stay close to what's working
`;
  } else {
    prompt += `Generate a MAJOR EVOLUTION based on the feedback:
- You can change genre, tempo, structure
- Incorporate the suggestions meaningfully
- Take the music in a new direction while staying musical
`;
  }

  return prompt;
}

/**
 * Extract Strudel code from Claude's response
 */
function extractStrudelCode(response) {
  // Try to extract code from code block
  const codeBlockMatch = response.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);

  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // If no code block, try to find common Strudel patterns
  const lines = response.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('sound(') || trimmed.includes('note(') || trimmed.includes('s(')) {
      return trimmed;
    }
  }

  // Fallback: return the whole response
  return response.trim();
}
