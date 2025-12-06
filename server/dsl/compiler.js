/**
 * Strudel Compiler
 * Compiles layer state to Strudel pattern code
 */

// Helper to format a value that could be a number or a pattern string
function formatValue(value) {
  if (typeof value === 'number') {
    return value.toFixed(2);
  }
  // It's a pattern string like "sine" or "sine.range(0,1)"
  return value;
}

export function compileToStrudel(state) {
  const activeLayers = state.getActiveLayers();

  if (activeLayers.length === 0) {
    return `silence`;
  }

  const parts = activeLayers.map(layer => {
    let pattern = layer.pattern;

    // Apply gain if not 1.0
    if (layer.gain !== null && layer.gain !== undefined && Math.abs(layer.gain - 1.0) > 0.001) {
      pattern = `(${pattern}).gain(${formatValue(layer.gain)})`;
    }

    // Apply effects in order
    const effects = layer.effects;
    if (effects.lpf !== null && effects.lpf !== undefined) {
      pattern = `(${pattern}).lpf(${formatValue(effects.lpf)})`;
    }
    if (effects.hpf !== null && effects.hpf !== undefined) {
      pattern = `(${pattern}).hpf(${formatValue(effects.hpf)})`;
    }
    if (effects.room !== null && effects.room !== undefined) {
      pattern = `(${pattern}).room(${formatValue(effects.room)})`;
    }
    if (effects.delay !== null && effects.delay !== undefined) {
      pattern = `(${pattern}).delay(${formatValue(effects.delay)})`;
    }
    if (effects.pan !== null && effects.pan !== undefined) {
      pattern = `(${pattern}).pan(${formatValue(effects.pan)})`;
    }
    if (effects.late !== null && effects.late !== undefined) {
      pattern = `(${pattern}).late(${formatValue(effects.late)})`;
    }
    if (effects.distort !== null && effects.distort !== undefined) {
      pattern = `(${pattern}).distort(${formatValue(effects.distort)})`;
    }
    if (effects.crush !== null && effects.crush !== undefined) {
      pattern = `(${pattern}).crush(${formatValue(effects.crush)})`;
    }

    return `  ${pattern}`;
  });

  // No .cps() here - BPM is set globally via setcps()
  return `stack(\n${parts.join(',\n')}\n)`;
}
