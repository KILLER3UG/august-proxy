/**
 * builtin-provider.js — Built-in memory provider wrapper.
 * Wraps the existing memory.json + MEMORY.md system.
 *
 * Implements frozen snapshot pattern: system prompt is stable for prefix cache.
 * Mid-session writes update files on disk but do not change the system prompt.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const MemoryProvider = require('./memory-provider');

// ── Paths ──
// The actual memory files used by August's core memory system.
const { dataPath } = require('../../lib/data-paths');
const CORE_MEMORY_FILE = dataPath('august_core_memory.json');

// ── Builtin Provider ──

class BuiltinProvider extends MemoryProvider {
  constructor() {
    super('builtin');
    this._config = {};
    this._sessionId = '';
    this._frozenSnapshot = null;
    this._snapshotTimestamp = null;
  }

  /**
   * Check if builtin provider is available.
   */
  async isAvailable() {
    return true; // Always available
  }

  /**
   * Initialize the builtin provider.
   */
  async initialize(sessionId, config = {}) {
    this._sessionId = sessionId;
    this._config = config;
    this._frozenSnapshot = null;
    this._snapshotTimestamp = null;
    this._initialized = true;
  }

  /**
   * System prompt block from memory files.
   * Uses frozen snapshot pattern for prefix cache stability.
   */
  systemPromptBlock() {
    // Return frozen snapshot if available and recent (within 5 minutes)
    const now = Date.now();
    if (this._frozenSnapshot && this._snapshotTimestamp) {
      if (now - this._snapshotTimestamp < 5 * 60 * 1000) {
        return this._frozenSnapshot;
      }
    }

    // Build fresh snapshot
    const block = this._buildSystemPromptBlock();
    this._frozenSnapshot = block;
    this._snapshotTimestamp = now;
    return block;
  }

  /**
   * Build system prompt block from memory files.
   */
  _buildSystemPromptBlock() {
    // Read from the actual core memory file used by August's memory system
    try {
      if (fs.existsSync(CORE_MEMORY_FILE)) {
        const data = JSON.parse(fs.readFileSync(CORE_MEMORY_FILE, 'utf8'));
        if (data && Object.keys(data).length > 0) {
          return `<august_core_memory>\n${JSON.stringify(data, null, 2)}\n</august_core_memory>`;
        }
      }
    } catch {}
    return '';
  }

  /**
   * Prefetch context — returns core memory content for the prompt.
   */
  async prefetch(query, sessionId = '') {
    try {
      if (fs.existsSync(CORE_MEMORY_FILE)) {
        const data = JSON.parse(fs.readFileSync(CORE_MEMORY_FILE, 'utf8'));
        if (data && Object.keys(data).length > 0) {
          return JSON.stringify(data, null, 2);
        }
      }
    } catch {}
    return '';
  }

  /**
   * Sync a completed turn (update memory files).
   */
  async syncTurn(userContent, assistantContent, sessionId = '', messages = []) {
    // For builtin provider, we don't automatically extract facts
    // The memory-tools.js handles explicit memory writes
    // This is a no-op for now
  }

  /**
   * Mirror memory writes to files.
   */
  async onMemoryWrite(action, target, content, metadata = null) {
    // Invalidate frozen snapshot on write
    this._frozenSnapshot = null;
    this._snapshotTimestamp = null;

    // The actual file writes are handled by memory-tools.js
    // This hook is for external providers to mirror writes
  }

  /**
   * Invalidate the frozen snapshot (called after writes).
   */
  invalidateSnapshot() {
    this._frozenSnapshot = null;
    this._snapshotTimestamp = null;
  }

  /**
   * Get core memory data.
   */
  getCoreMemory() {
    try {
      if (fs.existsSync(CORE_MEMORY_FILE)) {
        return JSON.parse(fs.readFileSync(CORE_MEMORY_FILE, 'utf8'));
      }
    } catch {}
    return {};
  }
}

module.exports = BuiltinProvider;
