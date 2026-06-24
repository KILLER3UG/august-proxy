/**
 * demo/index.js — Demo memory provider.
 * Zero-dependency reference implementation backed by a local JSON store.
 * Demonstrates the full MemoryProvider lifecycle.
 *
 * Storage: ~/.august/providers/demo/store.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const MemoryProvider = require('../../memory-provider');

const STORE_DIR = path.join(os.homedir(), '.august', 'providers', 'demo');
const STORE_FILE = path.join(STORE_DIR, 'store.json');

class DemoProvider extends MemoryProvider {
  constructor() {
    super('demo');
    this._store = { summaries: [], created: null };
    this._sessionId = '';
  }

  async isAvailable() {
    return true;
  }

  async initialize(sessionId, config = {}) {
    this._sessionId = sessionId || 'default';
    fs.mkdirSync(STORE_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      try {
        this._store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      } catch {
        this._store = { summaries: [], created: null };
      }
    }
    if (!this._store.created) {
      this._store.created = new Date().toISOString();
    }
    this._initialized = true;
    console.log(`[DemoProvider] Initialized (${this._store.summaries.length} stored summaries)`);
  }

  systemPromptBlock() {
    const count = this._store.summaries.length;
    if (count === 0) return '';
    return `<provider name="demo">\nDemo memory provider with ${count} stored session summary(ies).\n</provider>`;
  }

  async prefetch(query, sessionId = '') {
    if (!this._store.summaries.length || !query) return '';

    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    if (!terms.length) return '';

    const matches = this._store.summaries.filter(s =>
      terms.some(t => s.summary.toLowerCase().includes(t))
    );

    if (!matches.length) return '';
    return `<demo_context>\n${matches.map(s => `- [${s.topic || 'untitled'}] ${s.summary}`).join('\n')}\n</demo_context>`;
  }

  async syncTurn(userContent, assistantContent, sessionId, messages) {
    if (!userContent || !assistantContent) return;

    const summary = {
      topic: (userContent || '').slice(0, 80),
      summary: (assistantContent || '').slice(0, 200),
      timestamp: new Date().toISOString()
    };

    this._store.summaries.push(summary);

    // Keep last 50 summaries
    if (this._store.summaries.length > 50) {
      this._store.summaries = this._store.summaries.slice(-50);
    }

    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(this._store, null, 2));
    } catch (err) {
      console.warn('[DemoProvider] Failed to persist store:', err.message);
    }
  }
}

module.exports = DemoProvider;
