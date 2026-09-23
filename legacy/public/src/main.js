import { io } from 'socket.io-client';
import { AudioManager } from './audioManager.js';
import '../style.css';

// Initialize Socket.io
const socket = io();

// Initialize AudioManager
const audioManager = new AudioManager();

// Current state
let currentLayerState = null;
let currentCompiledCode = '';

// UI State
let isListening = false;

// Visualizer state
let analyser = null;
let visualizerAnimationId = null;
const NUM_BARS = 16;

// DOM elements
const startBtn = document.getElementById('start-btn');
const statusEl = document.getElementById('status');
const listenersEl = document.getElementById('listeners');
const feedbackSection = document.getElementById('feedback-section');
const likeBtn = document.getElementById('like-btn');
const dislikeBtn = document.getElementById('dislike-btn');
const suggestBtn = document.getElementById('suggest-btn');
const suggestionInput = document.getElementById('suggestion-input');
const feedbackFeed = document.getElementById('feedback-feed');
const patternCodeEl = document.getElementById('pattern-code');
const visualizerBarsEl = document.getElementById('visualizer-bars');

// Start Listening button handler
startBtn.addEventListener('click', async () => {
  try {
    startBtn.textContent = 'Initializing';
    startBtn.classList.add('loading');
    startBtn.disabled = true;

    // Initialize audio (requires user click)
    await audioManager.initialize();

    // "Tuning in" sound - like finding a radio station
    const startPattern = `stack(
      note("c2").s("sine").gain(0.08).lpf(sine.range(200,800).fast(3)).room(0.5),
      note("c4").s("triangle").gain(0.04).lpf(sine.range(400,2000).fast(7)).room(0.3)
    ).slow(2)`;
    audioManager.editor.setCode(startPattern);
    await audioManager.editor.evaluate(startPattern);
    audioManager.isPlaying = true;

    // Setup audio analyser for visualizer
    setupAudioAnalyser();

    // Show main UI
    document.getElementById('landing').style.display = 'none';
    document.getElementById('main-ui').style.display = 'block';

    isListening = true;
    updateStatus('Listening');
  } catch (error) {
    console.error('Failed to start audio:', error);
    console.error('Error stack:', error.stack);
    startBtn.textContent = 'Error — Try Again';
    startBtn.classList.remove('loading');
    startBtn.disabled = false;
  }
});

// Setup Web Audio analyser for visualizer
function setupAudioAnalyser() {
  try {
    const audioContext = audioManager.repl?.audioContext;
    if (!audioContext) {
      console.warn('AudioContext not available for visualizer');
      animateVisualizerSimulated();
      return;
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.8;

    visualizerBarsEl.classList.add('active');
    animateVisualizer();
  } catch (err) {
    console.warn('Could not setup audio analyser:', err);
    animateVisualizerSimulated();
  }
}

// Animate visualizer bars based on audio
function animateVisualizer() {
  if (!analyser) {
    animateVisualizerSimulated();
    return;
  }

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const bars = visualizerBarsEl.querySelectorAll('.bar');

  function draw() {
    visualizerAnimationId = requestAnimationFrame(draw);

    analyser.getByteFrequencyData(dataArray);

    const step = Math.floor(bufferLength / NUM_BARS);
    bars.forEach((bar, i) => {
      const value = dataArray[i * step] || 0;
      const height = Math.max(4, (value / 255) * 100);
      bar.style.height = `${height}px`;
      bar.style.opacity = 0.4 + (value / 255) * 0.6;
    });
  }

  draw();
}

// Simulated visualizer when analyser isn't available
function animateVisualizerSimulated() {
  const bars = visualizerBarsEl.querySelectorAll('.bar');
  let phase = 0;

  function draw() {
    visualizerAnimationId = requestAnimationFrame(draw);
    phase += 0.05;

    bars.forEach((bar, i) => {
      const wave = Math.sin(phase + i * 0.4) * 0.5 + 0.5;
      const noise = Math.random() * 0.2;
      const value = wave + noise;
      const height = Math.max(4, value * 80);
      bar.style.height = `${height}px`;
      bar.style.opacity = 0.4 + value * 0.4;
    });
  }

  visualizerBarsEl.classList.add('active');
  draw();
}

// Update the pattern code display with crossfade transition
function updatePatternCode(code, animate = true) {
  if (!patternCodeEl) return;

  const codeEl = patternCodeEl.querySelector('code');
  if (!codeEl) return;

  const display = patternCodeEl.closest('.code-display');

  if (animate && display) {
    display.classList.add('transitioning-out');

    setTimeout(() => {
      const formattedCode = formatPatternCode(code);
      codeEl.innerHTML = formattedCode;

      display.classList.remove('transitioning-out');
      display.classList.add('transitioning-in');

      setTimeout(() => {
        display.classList.remove('transitioning-in');
      }, 500);
    }, 300);
  } else {
    const formattedCode = formatPatternCode(code);
    codeEl.innerHTML = formattedCode;
  }
}

// Simple syntax highlighting for Strudel code
function formatPatternCode(code) {
  let formatted = escapeHtml(code);

  formatted = formatted.replace(/"([^"]*)"/g, '<span class="string">"$1"</span>');
  formatted = formatted.replace(/'([^']*)'/g, '<span class="string">\'$1\'</span>');
  formatted = formatted.replace(/\b(\d+\.?\d*)\b/g, '<span class="number">$1</span>');

  const keywords = ['stack', 'note', 's', 'sound', 'slow', 'fast', 'gain', 'room', 'delay', 'lpf', 'hpf', 'pan', 'cps', 'loopAt', 'fit', 'chop', 'rev', 'jux', 'sometimes', 'every', 'off', 'decay', 'attack', 'release'];
  keywords.forEach(kw => {
    const regex = new RegExp(`\\b(${kw})\\(`, 'g');
    formatted = formatted.replace(regex, '<span class="function">$1</span>(');
  });

  return formatted;
}

// Socket.io event handlers
socket.on('connect', () => {
  updateConnectionStatus(true);
});

socket.on('disconnect', () => {
  updateConnectionStatus(false);
});

// Music update event (DSL v2)
socket.on('music-update', async (data) => {
  const { compiled, state: musicState, bpm, intent } = data;

  console.log('📥 Received music-update:', compiled?.substring(0, 80) + '...');

  currentCompiledCode = compiled;

  // Update intent display
  if (intent) {
    updateIntentDisplay(intent);
  }

  // Update UI
  if (musicState) {
    updateSceneJourney(musicState);
    updateVoicesDisplay(musicState);
    updateEnergyDisplay(musicState);
  }

  if (isListening && audioManager.isInitialized) {
    try {
      triggerPatternTransition();
      console.log('🎵 Playing:', compiled?.substring(0, 60));
      await audioManager.playCompiledPattern(compiled, bpm);
    } catch (error) {
      console.error('Error playing music:', error);
    }
  } else {
    console.log('⏸️ Not playing - isListening:', isListening, 'initialized:', audioManager.isInitialized);
  }
});

// Legacy layer-update event (backwards compat)
socket.on('layer-update', async (data) => {
  const { layerState, compiled, intent } = data;

  currentCompiledCode = compiled;

  if (intent) {
    updateIntentDisplay(intent);
  }

  if (layerState) {
    updateVoicesDisplay(layerState);
    updateEnergyDisplay(layerState);
  }

  if (isListening && audioManager.isInitialized) {
    try {
      triggerPatternTransition();
      await audioManager.updateLayers(layerState);
    } catch (error) {
      console.error('Error updating layers:', error);
    }
  }
});

// Update the artistic intent display
let intentTimeout = null;
function updateIntentDisplay(intent) {
  const container = document.getElementById('intent-display');
  if (!container) return;

  // Clear any pending timeout
  if (intentTimeout) {
    clearTimeout(intentTimeout);
  }

  // Fade out existing intent if any
  const existing = container.querySelector('.intent-text');
  if (existing) {
    existing.classList.add('fading-out');
    setTimeout(() => existing.remove(), 500);
  }

  // Create new intent element after short delay
  setTimeout(() => {
    const intentEl = document.createElement('p');
    intentEl.className = 'intent-text';
    intentEl.textContent = intent;
    container.appendChild(intentEl);

    // Auto-fade after 8 seconds
    intentTimeout = setTimeout(() => {
      intentEl.classList.add('fading-out');
      setTimeout(() => intentEl.remove(), 500);
    }, 8000);
  }, existing ? 300 : 0);
}

// Update the scene journey visualization (shows current status in v2)
function updateSceneJourney(state) {
  const container = document.getElementById('scene-journey');
  if (!container) return;

  const track = container.querySelector('.journey-track');
  if (!track) return;

  const voices = state.voices || {};
  const voiceCount = Object.keys(voices).length;
  const isTransitioning = state.transitioning;

  if (voiceCount === 0) {
    track.innerHTML = '';
    return;
  }

  const status = isTransitioning ? 'transitioning' : 'playing';
  track.innerHTML = `
    <div class="scene-node active">
      <span class="scene-name">${status}</span>
      <span class="scene-layers">${voiceCount} voices</span>
    </div>
  `;
}

// Update energy meter display
function updateEnergyDisplay(state) {
  const container = document.getElementById('active-layers');
  if (!container) return;

  const energy = state.energy;
  if (!energy) return;

  // Find or create energy meter
  let meter = container.querySelector('.energy-meter');
  if (!meter) {
    meter = document.createElement('div');
    meter.className = 'energy-meter';
    container.insertBefore(meter, container.firstChild);
  }

  const percent = Math.min(100, Math.round(energy.usage * 100));
  const statusClass = energy.status;

  meter.innerHTML = `
    <div class="energy-bar">
      <div class="energy-fill ${statusClass}" style="width: ${percent}%"></div>
    </div>
    <span class="energy-label">${energy.status}</span>
  `;
}

// Update voices display (v2 format)
function updateVoicesDisplay(state) {
  const container = document.getElementById('active-layers');
  if (!container) return;

  const voices = state.voices || {};
  const voiceNames = Object.keys(voices);

  // Keep energy meter, update/create voices grid
  let grid = container.querySelector('.layers-grid');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'layers-grid';
    container.appendChild(grid);
  }

  if (voiceNames.length === 0) {
    grid.innerHTML = '';
    return;
  }

  function getVoiceType(name, pattern) {
    const n = name.toLowerCase();
    const p = (pattern || '').toLowerCase();
    if (n.includes('pad') || p.includes('swpad')) return 'pad';
    if (n.includes('bass') || n.includes('sub')) return 'bass';
    if (n.includes('drum') || n.includes('rhythm') || p.includes('bd') || p.includes('hh')) return 'drums';
    if (n.includes('lead') || n.includes('melody')) return 'lead';
    return '';
  }

  let html = '';
  for (const name of voiceNames) {
    const voice = voices[name];
    const type = getVoiceType(name, voice.pattern);
    const levelPercent = Math.round((voice.level || 0) * 100);
    const isTransitioning = voice.transitioning;

    html += `
      <div class="layer-chip ${isTransitioning ? 'transitioning' : ''}" data-type="${type}">
        <span class="layer-name">${name}</span>
        <div class="layer-gain">
          <div class="layer-gain-fill" style="width: ${levelPercent}%"></div>
        </div>
      </div>
    `;
  }

  grid.innerHTML = html;
}

// Update the active layers display (legacy v1 format)
function updateLayersDisplay(layerState) {
  const container = document.getElementById('active-layers');
  if (!container) return;

  const layers = layerState.layers || {};
  const layerOrder = layerState.layerOrder || [];

  if (layerOrder.length === 0) {
    container.innerHTML = '<div class="layers-placeholder">Layers will appear here</div>';
    return;
  }

  // Determine layer type from name or pattern
  function getLayerType(name, pattern) {
    const n = name.toLowerCase();
    const p = (pattern || '').toLowerCase();

    if (n.includes('pad') || p.includes('swpad')) return 'pad';
    if (n.includes('bass') || n.includes('sub')) return 'bass';
    if (n.includes('drum') || n.includes('kick') || n.includes('bd') || n.includes('hh') || n.includes('perc')) return 'drums';
    if (n.includes('lead') || n.includes('melody') || n.includes('synth')) return 'lead';
    return '';
  }

  let html = '<div class="layers-grid">';

  for (const name of layerOrder) {
    const layer = layers[name];
    if (!layer) continue;

    const type = getLayerType(name, layer.pattern);
    const gainPercent = Math.round((layer.gain || 0) * 100);
    const isMuted = layer.muted;

    html += `
      <div class="layer-chip ${isMuted ? 'muted' : ''}" data-type="${type}">
        <span class="layer-name">${name}</span>
        <div class="layer-gain">
          <div class="layer-gain-fill" style="width: ${gainPercent}%"></div>
        </div>
      </div>
    `;
  }

  html += '</div>';
  container.innerHTML = html;
}

// Legacy pattern-update event (fallback)
socket.on('pattern-update', async (data) => {
  // If we get old-style pattern updates, use legacy method
  if (isListening && audioManager.isInitialized && !data.layerState) {
    try {
      triggerPatternTransition();
      updatePatternCode(data.pattern);
      await audioManager.playPattern(data.pattern);
    } catch (error) {
      console.error('Error playing pattern:', error);
    }
  }
});

// Trigger visual feedback for transitions
function triggerPatternTransition() {
  const patternSection = document.querySelector('.pattern-section');

  if (patternSection) {
    patternSection.classList.add('transitioning');
    setTimeout(() => {
      patternSection.classList.remove('transitioning');
    }, 800);
  }

  if (visualizerBarsEl) {
    visualizerBarsEl.classList.add('pulse');
    setTimeout(() => {
      visualizerBarsEl.classList.remove('pulse');
    }, 600);
  }
}

socket.on('feedback-history', (history) => {
  feedbackFeed.innerHTML = '';
  if (history.length === 0) {
    feedbackFeed.innerHTML = '<p class="empty-state">No feedback yet</p>';
  } else {
    history.forEach(item => addFeedbackItem(item));
  }
});

socket.on('feedback-update', (data) => {
  addFeedbackItem(data);
});

function updateConnectionStatus(connected) {
  if (connected) {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
  } else {
    statusEl.textContent = 'Reconnecting...';
    statusEl.className = 'status disconnected';
  }
}

function updateStatus(message) {
  statusEl.textContent = message;
}

function showNotification(message) {
  const notification = document.createElement('div');
  notification.className = 'notification';
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('fade-out');
    setTimeout(() => notification.remove(), 500);
  }, 2000);
}

function sendFeedback(type, content = '') {
  socket.emit('feedback', {
    type,
    content,
    timestamp: Date.now()
  });
}

function addFeedbackItem(item) {
  const emptyState = feedbackFeed.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }

  const feedbackItem = document.createElement('div');
  feedbackItem.className = `feedback-item ${item.type}`;

  let typeLabel = '';
  if (item.type === 'like') {
    typeLabel = 'Liked';
  } else if (item.type === 'dislike') {
    typeLabel = 'Disliked';
  } else if (item.type === 'suggestion') {
    typeLabel = 'Suggestion';
  }

  const timeStr = new Date(item.timestamp).toLocaleTimeString();

  feedbackItem.innerHTML = `
    <div class="type">${typeLabel}</div>
    ${item.content ? `<div class="content">${escapeHtml(item.content)}</div>` : ''}
    <div class="time">${timeStr}</div>
  `;

  feedbackFeed.insertBefore(feedbackItem, feedbackFeed.firstChild);

  while (feedbackFeed.children.length > 50) {
    feedbackFeed.removeChild(feedbackFeed.lastChild);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Feedback button handlers
likeBtn.addEventListener('click', () => {
  sendFeedback('like');
  animateButton(likeBtn);
});

dislikeBtn.addEventListener('click', () => {
  sendFeedback('dislike');
  animateButton(dislikeBtn);
});

suggestBtn.addEventListener('click', () => {
  const suggestion = suggestionInput.value.trim();
  if (suggestion) {
    sendFeedback('suggestion', suggestion);
    suggestionInput.value = '';
    animateButton(suggestBtn);
  }
});

suggestionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    suggestBtn.click();
  }
});

function animateButton(button) {
  button.style.transform = 'scale(1.05)';
  setTimeout(() => {
    button.style.transform = '';
  }, 150);
}
