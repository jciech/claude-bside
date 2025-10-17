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

// Start Listening button handler
startBtn.addEventListener('click', async () => {
  try {
    startBtn.textContent = 'Initializing audio...';
    startBtn.disabled = true;

    // Initialize audio (requires user click)
    await audioManager.initialize();

    // Play initial pattern
    await audioManager.playPattern(currentPattern);

    // Show main UI
    document.getElementById('landing').style.display = 'none';
    document.getElementById('main-ui').style.display = 'block';

    isListening = true;
    updateStatus('🎵 Listening');
  } catch (error) {
    console.error('Failed to start audio:', error);
    startBtn.textContent = 'Error - Try Again';
    startBtn.disabled = false;
    alert('Failed to start audio. Please try again.');
  }
});

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
      await audioManager.playPattern(data.pattern);
      showNotification('🎵 New pattern!');
    } catch (error) {
      console.error('Error playing pattern:', error);
      showNotification('❌ Error');
    }
  }
});

socket.on('feedback-history', (history) => {
  feedbackFeed.innerHTML = '';
  if (history.length === 0) {
    feedbackFeed.innerHTML = '<p class="empty-state">No feedback yet. Be the first!</p>';
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
    statusEl.textContent = '🟢 Connected';
    statusEl.className = 'status connected';
  } else {
    statusEl.textContent = '🔴 Disconnected';
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
    typeLabel = '👍 Like';
  } else if (item.type === 'dislike') {
    typeLabel = '👎 Dislike';
  } else if (item.type === 'suggestion') {
    typeLabel = '💡 Suggestion';
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
  button.style.transform = 'scale(1.1)';
  setTimeout(() => {
    button.style.transform = '';
  }, 200);
}
