/**
 * fts-search.js — Full-Text Search for cross-session recall.
 * Inspired by Hermes's session search pattern.
 *
 * Primary backend: SQLite FTS5 (memory_fts table for checkpoints, session_fts for messages).
 * Fallback: in-memory token index when SQLite is unavailable.
 *
 * Provides searchWithSummary() that uses the LLM to synthesize coherent recall blocks.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const AUGUST_HOME = path.join(os.homedir(), '.august');
const SESSIONS_DIR = path.join(AUGUST_HOME, 'sessions');

class FtsSearch {
  constructor() {
    this._index = new Map(); // fallback in-memory index
    this._initialized = false;
    this._sqlite = null;
  }

  async initialize() {
    if (this._initialized) return;

    // Try SQLite FTS5 backend
    try {
      const sqliteMemory = require('./sqlite-memory-store');
      this._sqlite = sqliteMemory;
    } catch {
      this._sqlite = null;
    }

    // Always build fallback in-memory index for session file search
    await this._buildIndex();
    this._initialized = true;
    console.log(`[FtsSearch] Initialized with ${this._index.size} terms${this._sqlite ? ' + SQLite FTS5' : ''}`);
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

  _indexSession(sessionId, sessionData) {
    const messages = sessionData.messages || sessionData;
    if (!Array.isArray(messages)) return;

    messages.forEach((msg, index) => {
      const content = msg.content || msg.text || '';
      if (!content) return;

      const timestamp = msg.timestamp || sessionData.created_at || '';
      const terms = this._tokenize(content);
      for (const term of terms) {
        if (!this._index.has(term)) {
          this._index.set(term, []);
        }
        this._index.get(term).push({
          session_id: sessionId,
          message_index: index,
          content: content.slice(0, 200),
          timestamp
        });
      }
    });
  }

  _tokenize(text) {
    if (!text) return [];
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
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
   * Search across sessions using in-memory index.
   */
  async search(query, options = {}) {
    const { maxResults = 10, minScore = 0.1 } = options;

    const terms = this._tokenize(query);
    if (terms.length === 0) return [];

    const scores = new Map();

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

    const results = Array.from(scores.entries())
      .map(([sessionId, data]) => ({
        session_id: sessionId,
        score: data.score / terms.length,
        snippets: data.snippets,
        timestamp: data.timestamp
      }))
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return results;
  }

  /**
   * Search using SQLite FTS5 backend (checkpoints + facts).
   * Returns richer results with topic/summary/metadata.
   */
  async sqliteSearch(query, options = {}) {
    if (!this._sqlite) return [];

    const { maxResults = 5 } = options;

    try {
      const rows = this._sqlite.searchMemoryFts(query, { limit: maxResults });

      return (rows || []).map(r => ({
        id: r.id,
        topic: r.topic,
        summary: r.summary,
        score: Math.max(0, 1 - (r.ftsScore || 0) / 100),
        tags: Array.isArray(r.tags) ? r.tags : [],
        timestamp: r.timestamp
      }));
    } catch (err) {
      console.warn('[FtsSearch] SQLite search error:', err.message);
      return [];
    }
  }

  /**
   * Search with LLM summarization.
   * Falls back: try SQLite FTS5 first, then in-memory index.
   * Synthesizes coherent recall block from top results.
   */
  async searchWithSummary(query, options = {}) {
    const { sessionId, maxResults = 5 } = options;

    // Collect results from both backends
    const sqliteResults = await this.sqliteSearch(query, { maxResults });
    const inMemoryResults = await this.search(query, { maxResults });

    if (sqliteResults.length === 0 && inMemoryResults.length === 0) return null;

    // Build raw recall text
    const blocks = [];

    if (sqliteResults.length > 0) {
      blocks.push('=== Checkpoints ===');
      for (const r of sqliteResults.slice(0, 3)) {
        blocks.push(`- ${r.topic}: ${r.summary}`);
      }
    }

    if (inMemoryResults.length > 0) {
      blocks.push('=== Session excerpts ===');
      for (const r of inMemoryResults.slice(0, 3)) {
        for (const s of r.snippets) {
          blocks.push(`- [${r.session_id}] ${s}`);
        }
      }
    }

    const contextText = blocks.join('\n');

    // Summarize via LLM if available
    try {
      const { callWorkbenchTextOnlyModel } = require('../workbench/workbench');
      const { getWorkbenchSession } = require('../workbench/workbench');

      const ws = sessionId ? getWorkbenchSession(sessionId) : null;
      if (ws) {
        const summary = await callWorkbenchTextOnlyModel(ws, {
          system: 'You are a recall synthesizer. Summarize the following search results into 2-3 coherent sentences. Focus on what is most relevant to the query.',
          user: `Query: ${query}\n\nSearch results:\n${contextText}`,
          maxTokens: 256
        });

        return {
          summary: summary.trim(),
          raw: contextText,
          sources: {
            checkpoints: sqliteResults.length,
            sessions: inMemoryResults.length
          }
        };
      }
    } catch {
      // LLM unavailable — return raw context
    }

    return {
      summary: contextText.slice(0, 500),
      raw: contextText,
      sources: {
        checkpoints: sqliteResults.length,
        sessions: inMemoryResults.length
      }
    };
  }

  addSession(sessionId, messages) {
    if (!this._initialized) return;
    this._indexSession(sessionId, { messages });
  }

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

  getStats() {
    return {
      terms: this._index.size,
      initialized: this._initialized,
      sqlite: !!this._sqlite
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

module.exports = { FtsSearch, getFtsSearch };
