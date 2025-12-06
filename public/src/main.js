import { io } from 'socket.io-client';
import { AudioManager } from './audioManager.js';
import '../style.css';

// Initialize Socket.io
const socket = io();

// Initialize AudioManager
const audioManager = new AudioManager();

// Current pattern
let currentPattern = 'sound("bd sd").fast(2)';

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

    // Play initial pattern
    await audioManager.playPattern(currentPattern);

    // Setup audio analyser for visualizer
    setupAudioAnalyser();

    // Show main UI
    document.getElementById('landing').style.display = 'none';
    document.getElementById('main-ui').style.display = 'block';

    isListening = true;
    updateStatus('Listening');
    updatePatternCode(currentPattern, false); // No animation on initial load
  } catch (error) {
    console.error('Failed to start audio:', error);
    startBtn.textContent = 'Error — Try Again';
    startBtn.classList.remove('loading');
    startBtn.disabled = false;
  }
});

// Setup Web Audio analyser for visualizer
function setupAudioAnalyser() {
  try {
    const audioContext = audioManager.editor?.repl?.audioContext;
    if (!audioContext) {
      console.warn('AudioContext not available for visualizer');
      return;
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.8;

    // Try to connect to the audio destination
    // Strudel's output should be routed through the destination
    if (audioContext.destination) {
      // Create a gain node to tap into the audio
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 1;
      gainNode.connect(audioContext.destination);
      gainNode.connect(analyser);
    }

    // Start visualizer animation
    visualizerBarsEl.classList.add('active');
    animateVisualizer();
  } catch (err) {
    console.warn('Could not setup audio analyser:', err);
  }
}

// Animate visualizer bars based on audio
function animateVisualizer() {
  if (!analyser) {
    // Fallback: use simulated data
    animateVisualizerSimulated();
    return;
  }

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const bars = visualizerBarsEl.querySelectorAll('.bar');

  function draw() {
    visualizerAnimationId = requestAnimationFrame(draw);

    analyser.getByteFrequencyData(dataArray);

    // Map frequency data to bars
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
      // Create wave pattern with some randomness
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
    // Phase 1: Fade out old code
    display.classList.add('transitioning-out');

    setTimeout(() => {
      // Phase 2: Update content
      const formattedCode = formatPatternCode(code);
      codeEl.innerHTML = formattedCode;

      // Phase 3: Fade in new code
      display.classList.remove('transitioning-out');
      display.classList.add('transitioning-in');

      setTimeout(() => {
        display.classList.remove('transitioning-in');
      }, 500);
    }, 300);
  } else {
    // No animation - just update
    const formattedCode = formatPatternCode(code);
    codeEl.innerHTML = formattedCode;
  }
}

// Simple syntax highlighting for Strudel code
function formatPatternCode(code) {
  // Escape HTML first
  let formatted = escapeHtml(code);

  // Highlight strings
  formatted = formatted.replace(/"([^"]*)"/g, '<span class="string">"$1"</span>');
  formatted = formatted.replace(/'([^']*)'/g, '<span class="string">\'$1\'</span>');

  // Highlight numbers
  formatted = formatted.replace(/\b(\d+\.?\d*)\b/g, '<span class="number">$1</span>');

  // Highlight common Strudel functions
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

socket.on('pattern-update', async (data) => {
  currentPattern = data.pattern;

  if (isListening && audioManager.isInitialized) {
    try {
      // Trigger visual transition
      triggerPatternTransition();

      // Update code display with animation
      updatePatternCode(data.pattern);

      // Play the new pattern
      const result = await audioManager.playPattern(data.pattern);
      if (result.fallback) {
        console.warn('Pattern failed, using fallback:', result.error);
      }
    } catch (error) {
      console.error('Error playing pattern:', error);
    }
  }
});

// Trigger visual feedback for pattern transitions
function triggerPatternTransition() {
  const patternSection = document.querySelector('.pattern-section');

  // Ambient glow pulse
  if (patternSection) {
    patternSection.classList.add('transitioning');
    setTimeout(() => {
      patternSection.classList.remove('transitioning');
    }, 800);
  }

  // Visualizer bar pulse
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

// Update connection status
function updateConnectionStatus(connected) {
  if (connected) {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
  } else {
    statusEl.textContent = 'Reconnecting...';
    statusEl.className = 'status disconnected';
  }
}

// Update status message
function updateStatus(message) {
  statusEl.textContent = message;
}

// Show temporary notification
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

// Send feedback to server
function sendFeedback(type, content = '') {
  socket.emit('feedback', {
    type,
    content,
    timestamp: Date.now()
  });
}

// Add feedback item to feed
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

// Escape HTML to prevent XSS
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
