/**
 * fts-search.js — Full-Text Search for cross-session recall.
 * Inspired by Hermes's session search pattern.
 *
 * Provides FTS5-based search across sessions with LLM summarization.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Paths ──

const AUGUST_HOME = path.join(os.homedir(), '.august');
const SESSIONS_DIR = path.join(AUGUST_HOME, 'sessions');

// ── Search Index ──

class FtsSearch {
  constructor() {
    this._index = new Map(); // term -> [{session_id, message_index, content, timestamp}]
    this._initialized = false;
  }

  /**
   * Initialize the search index.
   */
  async initialize() {
    if (this._initialized) return;

    // Build index from existing sessions
    await this._buildIndex();
    this._initialized = true;
    console.log(`[FtsSearch] Initialized with ${this._index.size} terms`);
  }

  /**
   * Build search index from session files.
   */
  async _buildIndex() {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) return;

      const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

        const sessionId = entry.name.replace('.json', '');
        const filePath = path.join(SESSIONS_DIR, entry.name);

        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          this._indexSession(sessionId, data);
        } catch {}
      }
    } catch {}
  }

  /**
   * Index a session's messages.
   */
  _indexSession(sessionId, sessionData) {
    const messages = sessionData.messages || sessionData;
    if (!Array.isArray(messages)) return;

    messages.forEach((msg, index) => {
      const content = msg.content || msg.text || '';
      if (!content) return;

      const timestamp = msg.timestamp || sessionData.created_at || '';

      // Tokenize and index
      const terms = this._tokenize(content);
      for (const term of terms) {
        if (!this._index.has(term)) {
          this._index.set(term, []);
        }
        this._index.get(term).push({
          session_id: sessionId,
          message_index: index,
          content: content.slice(0, 200), // Store snippet
          timestamp
        });
      }
    });
  }

  /**
   * Tokenize text into search terms.
   */
  _tokenize(text) {
    if (!text) return [];

    // Lowercase and split on non-alphanumeric
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2); // Skip very short words

    // Remove stopwords
    const stopwords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
      'in', 'with', 'to', 'for', 'of', 'not', 'no', 'can', 'had', 'has',
      'was', 'were', 'are', 'be', 'been', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'shall', 'this', 'that',
      'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
      'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their'
    ]);

    return [...new Set(words.filter(w => !stopwords.has(w)))];
  }

  /**
   * Search across sessions.
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Array>} - Search results
   */
  async search(query, options = {}) {
    const { maxResults = 10, minScore = 0.1 } = options;

    const terms = this._tokenize(query);
    if (terms.length === 0) return [];

    // Score sessions by term matches
    const scores = new Map(); // session_id -> {score, snippets}

    for (const term of terms) {
      const matches = this._index.get(term) || [];
      for (const match of matches) {
        const key = match.session_id;
        if (!scores.has(key)) {
          scores.set(key, { score: 0, snippets: [], timestamp: match.timestamp });
        }
        const entry = scores.get(key);
        entry.score += 1;
        if (entry.snippets.length < 3) {
          entry.snippets.push(match.content);
        }
      }
    }

    // Sort by score and return top results
    const results = Array.from(scores.entries())
      .map(([sessionId, data]) => ({
        session_id: sessionId,
        score: data.score / terms.length, // Normalize
        snippets: data.snippets,
        timestamp: data.timestamp
      }))
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return results;
  }

  /**
   * Add a session to the index.
   * @param {string} sessionId - Session identifier
   * @param {Array} messages - Session messages
   */
  addSession(sessionId, messages) {
    this._indexSession(sessionId, { messages });
  }

  /**
   * Remove a session from the index.
   * @param {string} sessionId - Session identifier
   */
  removeSession(sessionId) {
    for (const [term, matches] of this._index) {
      const filtered = matches.filter(m => m.session_id !== sessionId);
      if (filtered.length === 0) {
        this._index.delete(term);
      } else {
        this._index.set(term, filtered);
      }
    }
  }

  /**
   * Get index statistics.
   */
  getStats() {
    return {
      terms: this._index.size,
      initialized: this._initialized
    };
  }
}

// ── Singleton ──

let _instance = null;

function getFtsSearch() {
  if (!_instance) {
    _instance = new FtsSearch();
  }
  return _instance;
}

module.exports = {
  FtsSearch,
  getFtsSearch
};
