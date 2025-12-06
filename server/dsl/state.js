/**
 * Layer State Management
 * Manages the musical state as a collection of named layers and scenes
 */

// Valid effects that can be applied to layers
const VALID_EFFECTS = ['room', 'delay', 'lpf', 'hpf', 'pan', 'late', 'distort', 'crush'];

export class Layer {
  constructor(name, pattern, options = {}) {
    this.name = name;
    this.pattern = pattern;
    this.muted = options.muted ?? false;
    this.gain = options.gain ?? 1.0;
    this.effects = {
      room: options.effects?.room ?? null,
      delay: options.effects?.delay ?? null,
      lpf: options.effects?.lpf ?? null,
      hpf: options.effects?.hpf ?? null,
      pan: options.effects?.pan ?? null,
      late: options.effects?.late ?? null,
      distort: options.effects?.distort ?? null,
      crush: options.effects?.crush ?? null,
    };
  }

  clone() {
    return new Layer(this.name, this.pattern, {
      muted: this.muted,
      gain: this.gain,
      effects: { ...this.effects },
    });
  }
}

export { VALID_EFFECTS };

/**
 * A Scene is a saved configuration of layers
 * Think of it like a preset or a "section" of a song
 */
export class Scene {
  constructor(name, description = '') {
    this.name = name;
    this.description = description;
    this.layers = new Map(); // layer name -> Layer snapshot
    this.layerOrder = [];
  }

  // Capture current state of specified layers (or all if none specified)
  captureFrom(state, layerNames = null) {
    const names = layerNames || state.layerOrder;
    this.layers.clear();
    this.layerOrder = [];

    for (const name of names) {
      const layer = state.getLayer(name);
      if (layer) {
        this.layers.set(name, layer.clone());
        this.layerOrder.push(name);
      }
    }
  }

  toJSON() {
    const layers = {};
    for (const [name, layer] of this.layers) {
      layers[name] = {
        pattern: layer.pattern,
        muted: layer.muted,
        gain: layer.gain,
        effects: layer.effects,
      };
    }
    return {
      name: this.name,
      description: this.description,
      layers,
      layerOrder: this.layerOrder,
    };
  }
}

export class Automation {
  constructor(id, layer, property, startBar, endBar, fromValue, toValue) {
    this.id = id;
    this.layer = layer;
    this.property = property;
    this.startBar = startBar;
    this.endBar = endBar;
    this.fromValue = fromValue;
    this.toValue = toValue;
  }

  valueAt(bar) {
    if (bar <= this.startBar) return this.fromValue;
    if (bar >= this.endBar) return this.toValue;

    const progress = (bar - this.startBar) / (this.endBar - this.startBar);
    return this.fromValue + (this.toValue - this.fromValue) * progress;
  }

  isComplete(bar) {
    return bar >= this.endBar;
  }
}

export class LayerState {
  constructor(bpm = 120) {
    this.layers = new Map();
    this.layerOrder = [];
    this.soloLayers = null;
    this.automations = [];
    this.currentBar = 0;
    this.bpm = bpm;
    this.nextAutomationId = 1;

    // Scene management
    this.scenes = new Map();
    this.currentScene = null;
    this.transitionTarget = null;
    this.transitionBars = 0;

    // Energy budget - total "weight" of active layers
    // Budget of 1.0 = comfortable, >1.0 = dense/intense, <0.5 = sparse
    this.energyBudget = 1.0;
  }

  /**
   * Calculate current energy usage based on active layers
   * Each layer contributes: gain * density_factor
   * density_factor estimates how "busy" the pattern is
   */
  calculateEnergy() {
    let total = 0;
    for (const name of this.layerOrder) {
      const layer = this.layers.get(name);
      if (!layer || layer.muted) continue;

      // Base energy from gain
      let energy = layer.gain;

      // Estimate density from pattern (rough heuristic)
      const pattern = layer.pattern.toLowerCase();

      // Drums/percussion are "heavier"
      if (pattern.includes('bd') || pattern.includes('kick')) energy *= 1.3;
      if (pattern.includes('sd') || pattern.includes('sn') || pattern.includes('cp')) energy *= 1.2;
      if (pattern.includes('hh') || pattern.includes('perc')) energy *= 0.8;

      // Breaks are heavy
      if (pattern.includes('breaks')) energy *= 1.4;

      // Pads are lighter
      if (pattern.includes('swpad') || pattern.includes('pad')) energy *= 0.6;

      // Fast patterns (*8, *16) are busier
      if (pattern.match(/\*\d{2}/)) energy *= 1.2;
      if (pattern.match(/\*[4-9]/)) energy *= 1.1;

      // Slow patterns are calmer
      if (pattern.includes('.slow(')) energy *= 0.8;

      total += energy;
    }
    return total;
  }

  /**
   * Get energy status for Claude
   */
  getEnergyStatus() {
    const current = this.calculateEnergy();
    const budget = this.energyBudget;
    const usage = current / budget;

    let status;
    if (usage < 0.3) status = 'sparse';
    else if (usage < 0.6) status = 'minimal';
    else if (usage < 0.85) status = 'balanced';
    else if (usage < 1.0) status = 'full';
    else if (usage < 1.3) status = 'dense';
    else status = 'overloaded';

    return {
      current: Math.round(current * 100) / 100,
      budget,
      usage: Math.round(usage * 100) / 100,
      status,
      headroom: Math.round((budget - current) * 100) / 100,
    };
  }

  addLayer(name, pattern, muted = false, gain = 1.0, effects = {}) {
    const layer = new Layer(name, pattern, { muted, gain, effects });
    this.layers.set(name, layer);
    this.layerOrder.push(name);
    return layer;
  }

  removeLayer(name) {
    if (this.layers.has(name)) {
      this.layers.delete(name);
      this.layerOrder = this.layerOrder.filter(n => n !== name);
      return true;
    }
    return false;
  }

  getLayer(name) {
    return this.layers.get(name);
  }

  hasLayer(name) {
    return this.layers.has(name);
  }

  updateLayerPattern(name, pattern) {
    const layer = this.layers.get(name);
    if (layer) {
      layer.pattern = pattern;
      return true;
    }
    return false;
  }

  muteLayer(name) {
    const layer = this.layers.get(name);
    if (layer) {
      layer.muted = true;
      return true;
    }
    return false;
  }

  unmuteLayer(name) {
    const layer = this.layers.get(name);
    if (layer) {
      layer.muted = false;
      return true;
    }
    return false;
  }

  setLayerGain(name, gain) {
    const layer = this.layers.get(name);
    if (layer) {
      layer.gain = gain;
      return true;
    }
    return false;
  }

  setLayerEffect(name, effect, value) {
    const layer = this.layers.get(name);
    if (layer && effect in layer.effects) {
      layer.effects[effect] = value;
      return true;
    }
    return false;
  }

  solo(names) {
    this.soloLayers = new Set(names);
  }

  unsolo() {
    this.soloLayers = null;
  }

  isLayerActive(name) {
    const layer = this.layers.get(name);
    if (!layer) return false;
    if (layer.muted) return false;
    if (this.soloLayers && !this.soloLayers.has(name)) return false;
    return true;
  }

  getActiveLayers() {
    return this.layerOrder
      .filter(name => this.isLayerActive(name))
      .map(name => this.layers.get(name));
  }

  addAutomation(layer, property, bars, fromValue, toValue) {
    const id = this.nextAutomationId++;
    const automation = new Automation(
      id,
      layer,
      property,
      this.currentBar,
      this.currentBar + bars,
      fromValue,
      toValue
    );
    this.automations.push(automation);
    return id;
  }

  reset() {
    this.layers.clear();
    this.layerOrder = [];
    this.soloLayers = null;
    this.automations = [];
    this.currentBar = 0;
    this.nextAutomationId = 1;
    this.scenes.clear();
    this.currentScene = null;
    this.transitionTarget = null;
    this.transitionBars = 0;
  }

  // ========== SCENE MANAGEMENT ==========

  /**
   * Define a scene from current layer state
   * @param {string} name - Scene name (e.g., "intro", "drop", "breakdown")
   * @param {string} description - Optional description
   * @param {string[]} layerNames - Optional specific layers to include (default: all)
   */
  defineScene(name, description = '', layerNames = null) {
    const scene = new Scene(name, description);
    scene.captureFrom(this, layerNames);
    this.scenes.set(name, scene);
    this.currentScene = name;
    return scene;
  }

  /**
   * Define a scene from explicit layer definitions (not from current state)
   */
  defineSceneFromLayers(name, description, layerDefs) {
    const scene = new Scene(name, description);
    for (const def of layerDefs) {
      const layer = new Layer(def.layer, def.pattern, {
        muted: def.muted ?? false,
        gain: def.gain ?? 1.0,
        effects: def.effects ?? {},
      });
      scene.layers.set(def.layer, layer);
      scene.layerOrder.push(def.layer);
    }
    this.scenes.set(name, scene);
    return scene;
  }

  /**
   * Get a scene by name
   */
  getScene(name) {
    return this.scenes.get(name);
  }

  /**
   * Check if a scene exists
   */
  hasScene(name) {
    return this.scenes.has(name);
  }

  /**
   * Transition to a scene over N bars
   * This sets up automations for fading layers in/out
   */
  transitionToScene(sceneName, bars = 4) {
    const scene = this.scenes.get(sceneName);
    if (!scene) return false;

    const currentLayers = new Set(this.layerOrder);
    const targetLayers = new Set(scene.layerOrder);

    // Layers to fade out (in current but not in target)
    for (const name of currentLayers) {
      if (!targetLayers.has(name)) {
        // Fade out and mute
        const layer = this.getLayer(name);
        if (layer && !layer.muted) {
          this.addAutomation(name, 'gain', bars, layer.gain, 0);
        }
      }
    }

    // Layers to fade in (in target but not in current, or muted)
    for (const name of targetLayers) {
      const targetLayer = scene.layers.get(name);
      const currentLayer = this.getLayer(name);

      if (!currentLayer) {
        // Add new layer at 0 gain, fade in
        this.addLayer(name, targetLayer.pattern, false, 0, targetLayer.effects);
        this.addAutomation(name, 'gain', bars, 0, targetLayer.gain);
      } else if (currentLayer.muted) {
        // Unmute and fade in
        currentLayer.muted = false;
        currentLayer.gain = 0;
        this.addAutomation(name, 'gain', bars, 0, targetLayer.gain);
      } else {
        // Crossfade to target gain if different
        if (Math.abs(currentLayer.gain - targetLayer.gain) > 0.01) {
          this.addAutomation(name, 'gain', bars, currentLayer.gain, targetLayer.gain);
        }
      }

      // Update pattern to target
      if (currentLayer && currentLayer.pattern !== targetLayer.pattern) {
        currentLayer.pattern = targetLayer.pattern;
      }
    }

    this.currentScene = sceneName;
    this.transitionTarget = sceneName;
    this.transitionBars = bars;

    return true;
  }

  /**
   * Apply a scene immediately (no transition)
   */
  applyScene(sceneName) {
    const scene = this.scenes.get(sceneName);
    if (!scene) return false;

    // Mute all current layers not in scene
    for (const name of this.layerOrder) {
      if (!scene.layers.has(name)) {
        this.muteLayer(name);
      }
    }

    // Apply scene layers
    for (const [name, sceneLayer] of scene.layers) {
      const currentLayer = this.getLayer(name);
      if (!currentLayer) {
        this.addLayer(name, sceneLayer.pattern, sceneLayer.muted, sceneLayer.gain, sceneLayer.effects);
      } else {
        currentLayer.pattern = sceneLayer.pattern;
        currentLayer.muted = sceneLayer.muted;
        currentLayer.gain = sceneLayer.gain;
        currentLayer.effects = { ...sceneLayer.effects };
      }
    }

    this.currentScene = sceneName;
    return true;
  }

  /**
   * Update an existing scene's layer
   */
  updateSceneLayer(sceneName, layerName, updates) {
    const scene = this.scenes.get(sceneName);
    if (!scene) return false;

    const layer = scene.layers.get(layerName);
    if (!layer) return false;

    if (updates.pattern !== undefined) layer.pattern = updates.pattern;
    if (updates.gain !== undefined) layer.gain = updates.gain;
    if (updates.muted !== undefined) layer.muted = updates.muted;
    if (updates.effects !== undefined) {
      layer.effects = { ...layer.effects, ...updates.effects };
    }

    return true;
  }

  /**
   * Add a layer to an existing scene
   */
  addLayerToScene(sceneName, layerDef) {
    const scene = this.scenes.get(sceneName);
    if (!scene) return false;

    const layer = new Layer(layerDef.layer, layerDef.pattern, {
      muted: layerDef.muted ?? false,
      gain: layerDef.gain ?? 1.0,
      effects: layerDef.effects ?? {},
    });
    scene.layers.set(layerDef.layer, layer);
    if (!scene.layerOrder.includes(layerDef.layer)) {
      scene.layerOrder.push(layerDef.layer);
    }

    return true;
  }

  /**
   * Remove a layer from a scene
   */
  removeLayerFromScene(sceneName, layerName) {
    const scene = this.scenes.get(sceneName);
    if (!scene) return false;

    scene.layers.delete(layerName);
    scene.layerOrder = scene.layerOrder.filter(n => n !== layerName);
    return true;
  }

  toJSON() {
    const layers = {};
    for (const [name, layer] of this.layers) {
      layers[name] = {
        pattern: layer.pattern,
        muted: layer.muted,
        gain: layer.gain,
        effects: layer.effects,
      };
    }

    const scenes = {};
    for (const [name, scene] of this.scenes) {
      scenes[name] = scene.toJSON();
    }

    return {
      layers,
      layerOrder: this.layerOrder,
      currentBar: this.currentBar,
      bpm: this.bpm,
      automationCount: this.automations.length,
      solo: this.soloLayers ? Array.from(this.soloLayers) : null,
      scenes,
      currentScene: this.currentScene,
      sceneCount: this.scenes.size,
      energy: this.getEnergyStatus(),
    };
  }
}
