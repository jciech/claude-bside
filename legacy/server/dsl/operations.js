/**
 * DSL Operations
 * Execute operations on the layer state
 */

export function executeOperation(state, op) {
  const handler = operationHandlers[op.op];
  if (!handler) {
    return { success: false, error: `Unknown operation: ${op.op}` };
  }
  return handler(state, op);
}

export function executeOperations(state, operations) {
  const results = [];
  for (const op of operations) {
    results.push(executeOperation(state, op));
  }
  return results;
}

const operationHandlers = {
  add(state, op) {
    if (!op.layer) {
      return { success: false, error: "add operation requires 'layer' field" };
    }
    if (!op.pattern) {
      return { success: false, error: "add operation requires 'pattern' field" };
    }

    // Upsert behavior: if layer exists, update it instead
    if (state.hasLayer(op.layer)) {
      const layer = state.getLayer(op.layer);
      layer.pattern = op.pattern;
      if (op.gain !== undefined) layer.gain = op.gain;
      if (op.muted !== undefined) layer.muted = op.muted;
      if (op.effects) {
        for (const [effect, value] of Object.entries(op.effects)) {
          if (value !== undefined && effect in layer.effects) {
            layer.effects[effect] = value;
          }
        }
      }
      return { success: true, updated: true };
    }

    state.addLayer(
      op.layer,
      op.pattern,
      op.muted ?? false,
      op.gain ?? 1.0,
      op.effects ?? {}
    );

    return { success: true };
  },

  remove(state, op) {
    if (!op.layer) {
      return { success: false, error: "remove operation requires 'layer' field" };
    }
    // Silently succeed if layer doesn't exist (idempotent)
    state.removeLayer(op.layer);
    return { success: true };
  },

  update(state, op) {
    if (!op.layer) {
      return { success: false, error: "update operation requires 'layer' field" };
    }

    const layer = state.getLayer(op.layer);
    if (!layer) {
      // If layer doesn't exist and we have a pattern, create it
      if (op.pattern) {
        state.addLayer(op.layer, op.pattern, false, op.gain ?? 1.0, op.effects ?? {});
        return { success: true, created: true };
      }
      // Otherwise silently succeed (nothing to update)
      return { success: true, skipped: true };
    }

    // Update pattern if provided
    if (op.pattern) {
      state.updateLayerPattern(op.layer, op.pattern);
    }

    // Update gain if provided
    if (op.gain !== undefined) {
      state.setLayerGain(op.layer, op.gain);
    }

    // Update effects if provided
    if (op.effects) {
      for (const [effect, value] of Object.entries(op.effects)) {
        if (value !== undefined) {
          state.setLayerEffect(op.layer, effect, value);
        }
      }
    }

    return { success: true };
  },

  mute(state, op) {
    if (!op.layer) {
      return { success: false, error: "mute operation requires 'layer' field" };
    }
    // Silently succeed if layer doesn't exist
    state.muteLayer(op.layer);
    return { success: true };
  },

  unmute(state, op) {
    if (!op.layer) {
      return { success: false, error: "unmute operation requires 'layer' field" };
    }
    // Silently succeed if layer doesn't exist
    state.unmuteLayer(op.layer);
    return { success: true };
  },

  solo(state, op) {
    if (!op.layers || !Array.isArray(op.layers)) {
      return { success: false, error: "solo operation requires 'layers' array" };
    }
    state.solo(op.layers);
    return { success: true };
  },

  unsolo(state) {
    state.unsolo();
    return { success: true };
  },

  fade_in(state, op) {
    if (!op.layer) {
      return { success: false, error: "fade_in operation requires 'layer' field" };
    }
    if (!op.bars) {
      return { success: false, error: "fade_in operation requires 'bars' field" };
    }
    if (!state.hasLayer(op.layer)) {
      // Silently skip if layer doesn't exist
      return { success: true, skipped: true };
    }

    const fromVal = op.from ?? 0.0;
    const toVal = op.to ?? 1.0;

    state.setLayerGain(op.layer, fromVal);
    const automationId = state.addAutomation(op.layer, 'gain', op.bars, fromVal, toVal);

    return { success: true, automationId };
  },

  fade_out(state, op) {
    if (!op.layer) {
      return { success: false, error: "fade_out operation requires 'layer' field" };
    }
    if (!op.bars) {
      return { success: false, error: "fade_out operation requires 'bars' field" };
    }

    const layer = state.getLayer(op.layer);
    if (!layer) {
      // Silently skip if layer doesn't exist
      return { success: true, skipped: true };
    }

    const fromVal = op.from ?? layer.gain;
    const toVal = op.to ?? 0.0;

    const automationId = state.addAutomation(op.layer, 'gain', op.bars, fromVal, toVal);

    return { success: true, automationId };
  },

  set_effect(state, op) {
    if (!op.layer) {
      return { success: false, error: "set_effect operation requires 'layer' field" };
    }
    if (!op.effect) {
      return { success: false, error: "set_effect operation requires 'effect' field" };
    }
    if (op.value === undefined) {
      return { success: false, error: "set_effect operation requires 'value' field" };
    }

    if (!state.hasLayer(op.layer)) {
      // Silently skip if layer doesn't exist
      return { success: true, skipped: true };
    }

    // Try to set the effect, silently succeed even if effect name is invalid
    state.setLayerEffect(op.layer, op.effect, op.value);
    return { success: true };
  },

  filter_sweep(state, op) {
    if (!op.layer) {
      return { success: false, error: "filter_sweep operation requires 'layer' field" };
    }
    if (!op.type) {
      return { success: false, error: "filter_sweep operation requires 'type' field" };
    }
    if (op.from === undefined || op.to === undefined) {
      return { success: false, error: "filter_sweep operation requires 'from' and 'to' fields" };
    }
    if (!op.bars) {
      return { success: false, error: "filter_sweep operation requires 'bars' field" };
    }
    if (!state.hasLayer(op.layer)) {
      return { success: false, error: "layer does not exist" };
    }

    const validTypes = ['lpf', 'hpf'];
    if (!validTypes.includes(op.type)) {
      return { success: false, error: "invalid filter type, use 'lpf' or 'hpf'" };
    }

    state.setLayerEffect(op.layer, op.type, op.from);
    const automationId = state.addAutomation(op.layer, op.type, op.bars, op.from, op.to);

    return { success: true, automationId };
  },

  set_gain(state, op) {
    if (!op.layer) {
      return { success: false, error: "set_gain operation requires 'layer' field" };
    }

    const gain = op.gain ?? op.value;
    if (gain === undefined) {
      return { success: false, error: "set_gain operation requires 'gain' or 'value' field" };
    }

    if (!state.setLayerGain(op.layer, gain)) {
      return { success: false, error: "layer does not exist" };
    }

    return { success: true };
  },

  // ========== TEMPO OPERATIONS ==========

  set_bpm(state, op) {
    if (op.bpm === undefined) {
      return { success: false, error: "set_bpm operation requires 'bpm' field" };
    }

    const bpm = Number(op.bpm);
    if (isNaN(bpm) || bpm < 40 || bpm > 200) {
      return { success: false, error: "bpm must be a number between 40 and 200" };
    }

    state.bpm = bpm;
    return { success: true, bpm };
  },

  // ========== SCENE OPERATIONS ==========

  /**
   * Define a scene from current layer state
   * { op: "define_scene", scene: "intro", description: "sparse opening" }
   * { op: "define_scene", scene: "drop", layers: ["drums", "bass"] } // specific layers only
   */
  define_scene(state, op) {
    if (!op.scene) {
      return { success: false, error: "define_scene operation requires 'scene' field" };
    }

    const scene = state.defineScene(op.scene, op.description || '', op.layers || null);
    return { success: true, scene: scene.name, layerCount: scene.layerOrder.length };
  },

  /**
   * Define a scene from explicit layer definitions
   * { op: "define_scene_layers", scene: "breakdown", description: "...", layers: [...] }
   */
  define_scene_layers(state, op) {
    if (!op.scene) {
      return { success: false, error: "define_scene_layers operation requires 'scene' field" };
    }
    if (!op.layers || !Array.isArray(op.layers)) {
      return { success: false, error: "define_scene_layers operation requires 'layers' array" };
    }

    const scene = state.defineSceneFromLayers(op.scene, op.description || '', op.layers);
    return { success: true, scene: scene.name, layerCount: scene.layerOrder.length };
  },

  /**
   * Transition to a scene over N bars
   * { op: "transition_to", scene: "drop", bars: 4 }
   */
  transition_to(state, op) {
    if (!op.scene) {
      return { success: false, error: "transition_to operation requires 'scene' field" };
    }
    if (!state.hasScene(op.scene)) {
      return { success: false, error: `scene '${op.scene}' does not exist` };
    }

    const bars = op.bars ?? 4;
    if (!state.transitionToScene(op.scene, bars)) {
      return { success: false, error: "transition failed" };
    }

    return { success: true, scene: op.scene, bars };
  },

  /**
   * Apply a scene immediately (no transition)
   * { op: "apply_scene", scene: "breakdown" }
   */
  apply_scene(state, op) {
    if (!op.scene) {
      return { success: false, error: "apply_scene operation requires 'scene' field" };
    }
    if (!state.hasScene(op.scene)) {
      return { success: false, error: `scene '${op.scene}' does not exist` };
    }

    if (!state.applyScene(op.scene)) {
      return { success: false, error: "apply scene failed" };
    }

    return { success: true, scene: op.scene };
  },

  /**
   * Update a layer within a scene (doesn't affect current playback until scene is applied)
   * { op: "update_scene_layer", scene: "drop", layer: "bass", pattern: "..." }
   */
  update_scene_layer(state, op) {
    if (!op.scene) {
      return { success: false, error: "update_scene_layer operation requires 'scene' field" };
    }
    if (!op.layer) {
      return { success: false, error: "update_scene_layer operation requires 'layer' field" };
    }

    const updates = {};
    if (op.pattern !== undefined) updates.pattern = op.pattern;
    if (op.gain !== undefined) updates.gain = op.gain;
    if (op.muted !== undefined) updates.muted = op.muted;
    if (op.effects !== undefined) updates.effects = op.effects;

    if (!state.updateSceneLayer(op.scene, op.layer, updates)) {
      return { success: false, error: "scene or layer does not exist" };
    }

    return { success: true };
  },

  /**
   * Add a layer to an existing scene
   * { op: "add_to_scene", scene: "drop", layer: "riser", pattern: "...", gain: 0.5 }
   */
  add_to_scene(state, op) {
    if (!op.scene) {
      return { success: false, error: "add_to_scene operation requires 'scene' field" };
    }
    if (!op.layer || !op.pattern) {
      return { success: false, error: "add_to_scene operation requires 'layer' and 'pattern' fields" };
    }

    if (!state.addLayerToScene(op.scene, {
      layer: op.layer,
      pattern: op.pattern,
      gain: op.gain ?? 1.0,
      muted: op.muted ?? false,
      effects: op.effects ?? {},
    })) {
      return { success: false, error: "scene does not exist" };
    }

    return { success: true };
  },

  /**
   * Remove a layer from a scene
   * { op: "remove_from_scene", scene: "drop", layer: "riser" }
   */
  remove_from_scene(state, op) {
    if (!op.scene) {
      return { success: false, error: "remove_from_scene operation requires 'scene' field" };
    }
    if (!op.layer) {
      return { success: false, error: "remove_from_scene operation requires 'layer' field" };
    }

    if (!state.removeLayerFromScene(op.scene, op.layer)) {
      return { success: false, error: "scene or layer does not exist" };
    }

    return { success: true };
  },
};
