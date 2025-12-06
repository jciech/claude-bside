/**
 * DSL v2 - Strudel Compiler
 *
 * Compiles MusicState to a Strudel pattern string.
 * Much simpler - just stack patterns with their levels.
 */

export function compile(state) {
  const voices = state.getAudibleVoices();

  if (voices.length === 0) {
    return 'silence';
  }

  // Build pattern for each voice
  const parts = voices.map(voice => {
    let pattern = voice.pattern;

    // Apply level as gain (only if not 1.0)
    if (Math.abs(voice.level - 1.0) > 0.001) {
      pattern = `(${pattern}).gain(${voice.level.toFixed(2)})`;
    }

    return `  ${pattern}`;
  });

  // Stack all voices
  if (parts.length === 1) {
    return parts[0].trim();
  }

  return `stack(\n${parts.join(',\n')}\n)`;
}
