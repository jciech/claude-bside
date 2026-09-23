/**
 * Automation Processor
 * Handles time-based changes (fades, sweeps, etc.)
 */

export function processTick(state, bar) {
  const barChanged = state.currentBar !== bar;
  state.currentBar = bar;

  if (!barChanged && state.automations.length === 0) {
    return {
      stateChanged: false,
      completedAutomations: 0,
    };
  }

  let stateChanged = false;
  let completedCount = 0;

  // Process automations in reverse order so we can safely remove completed ones
  for (let i = state.automations.length - 1; i >= 0; i--) {
    const auto = state.automations[i];

    if (bar >= auto.startBar) {
      const value = auto.valueAt(bar);
      const applied = applyAutomationValue(state, auto.layer, auto.property, value);

      if (applied) {
        stateChanged = true;
      }

      if (auto.isComplete(bar)) {
        state.automations.splice(i, 1);
        completedCount++;
      }
    }
  }

  return {
    stateChanged,
    completedAutomations: completedCount,
  };
}

function applyAutomationValue(state, layerName, property, value) {
  const layer = state.getLayer(layerName);
  if (!layer) return false;

  switch (property) {
    case 'gain':
      layer.gain = value;
      return true;
    case 'room':
    case 'delay':
    case 'lpf':
    case 'hpf':
    case 'pan':
      layer.effects[property] = value;
      return true;
    default:
      return false;
  }
}
