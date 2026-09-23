/**
 * Style Memory System
 * Tracks and learns from community feedback to build musical preferences
 */

export class StyleMemory {
  constructor() {
    this.reset();
  }

  reset() {
    this.likedElements = new Set();
    this.dislikedElements = new Set();
    this.suggestions = [];
    this.tempoPreferences = [];
    this.likeCount = 0;
    this.dislikeCount = 0;
    this.patterns = []; // History of patterns with their feedback scores
  }

  /**
   * Process feedback and update memory
   * Feedback now includes patternId and pattern snapshot from when it was submitted
   * @param {Object} feedback - Feedback item with pattern snapshot
   */
  processFeedback(feedback) {
    if (feedback.type === 'like') {
      this.likeCount++;
      this.recordPatternSuccess(feedback.patternId, feedback.pattern, 1);
    } else if (feedback.type === 'dislike') {
      this.dislikeCount++;
      this.recordPatternSuccess(feedback.patternId, feedback.pattern, -1);
    } else if (feedback.type === 'suggestion') {
      this.processSuggestion(feedback.content, feedback.patternId);
    }
  }

  /**
   * Record pattern success/failure
   * Now indexed by patternId for accurate attribution
   */
  recordPatternSuccess(patternId, patternCode, score) {
    // Use patternId as the primary key for accurate attribution
    const existing = this.patterns.find(p => p.id === patternId);

    if (existing) {
      existing.score += score;
      existing.feedbackCount++;
    } else {
      this.patterns.push({
        id: patternId,
        code: patternCode,
        score,
        feedbackCount: 1,
        timestamp: Date.now()
      });
    }

    // Keep only last 100 patterns
    if (this.patterns.length > 100) {
      this.patterns = this.patterns.slice(-100);
    }
  }

  /**
   * Process text suggestion and extract musical intent
   */
  processSuggestion(text, patternId) {
    const lowercased = text.toLowerCase();

    this.suggestions.push({
      text,
      patternId,
      timestamp: Date.now()
    });

    // Keep only last 20 suggestions
    if (this.suggestions.length > 20) {
      this.suggestions = this.suggestions.slice(-20);
    }

    // Extract musical elements
    this.extractMusicalElements(lowercased);
  }

  /**
   * Extract musical elements from text
   */
  extractMusicalElements(text) {
    // Tempo keywords
    if (text.includes('faster') || text.includes('speed up') || text.includes('quick')) {
      this.tempoPreferences.push('faster');
    }
    if (text.includes('slower') || text.includes('slow down') || text.includes('chill')) {
      this.tempoPreferences.push('slower');
    }

    // Instruments/sounds
    const instruments = ['bass', 'drum', 'kick', 'snare', 'hihat', 'synth', 'pad',
                        'lead', 'piano', 'guitar', 'strings', 'brass'];

    for (const instrument of instruments) {
      if (text.includes(instrument)) {
        if (text.includes('more ' + instrument) || text.includes('add ' + instrument)) {
          this.likedElements.add(instrument);
        } else if (text.includes('less ' + instrument) || text.includes('remove ' + instrument)) {
          this.dislikedElements.add(instrument);
        }
      }
    }

    // Genres/vibes
    const genres = ['techno', 'house', 'ambient', 'jazz', 'funk', 'dnb', 'drum and bass',
                   'breakbeat', 'trap', 'dubstep', 'minimal', 'acid'];

    for (const genre of genres) {
      if (text.includes(genre)) {
        this.likedElements.add(genre);
      }
    }
  }

  /**
   * Get summary of current preferences
   */
  getSummary() {
    const netScore = this.likeCount - this.dislikeCount;

    let preferredTempo = 'Moderate (120-130 BPM)';
    const fasterCount = this.tempoPreferences.filter(t => t === 'faster').length;
    const slowerCount = this.tempoPreferences.filter(t => t === 'slower').length;

    if (fasterCount > slowerCount) {
      preferredTempo = 'Fast (130-150 BPM)';
    } else if (slowerCount > fasterCount) {
      preferredTempo = 'Slow (90-110 BPM)';
    }

    let vibe = 'Exploratory';
    if (netScore > 5) {
      vibe = 'Crowd is loving it!';
    } else if (netScore < -3) {
      vibe = 'Need to switch things up';
    }

    // Get top and bottom patterns by score
    const sortedPatterns = [...this.patterns].sort((a, b) => b.score - a.score);
    const topPatterns = sortedPatterns
      .filter(p => p.score > 0)
      .slice(0, 3)
      .map(p => ({ code: p.code, score: p.score }));
    const bottomPatterns = sortedPatterns
      .filter(p => p.score < 0)
      .slice(-3)
      .map(p => ({ code: p.code, score: p.score }));

    return {
      likedElements: Array.from(this.likedElements),
      dislikedElements: Array.from(this.dislikedElements),
      preferredTempo,
      vibe,
      totalFeedback: this.likeCount + this.dislikeCount + this.suggestions.length,
      netScore,
      topPatterns,
      bottomPatterns
    };
  }

  /**
   * Export style profile as JSON
   */
  exportProfile() {
    return {
      summary: this.getSummary(),
      recentSuggestions: this.suggestions.slice(-10),
      topPatterns: this.patterns
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(p => ({
          id: p.id,
          score: p.score,
          feedbackCount: p.feedbackCount,
          code: p.code.slice(0, 100) // Truncate for readability
        })),
      exported: new Date().toISOString()
    };
  }

  /**
   * Get recent feedback for context
   * @param {number} count - Number of recent feedback items to return
   */
  getRecentFeedback(allFeedback, count = 10) {
    return allFeedback.slice(-count);
  }
}
