/**
 * memory-manager.js — Orchestrates multiple memory providers.
 * Inspired by Hermes's memory_manager.py pattern.
 *
 * Manages built-in provider + at most ONE external provider.
 * Provides background sync, context fencing, and lifecycle hooks.
 */

const { EventEmitter } = require('events');

/**
 * MemoryManager orchestrates memory providers.
 */
class MemoryManager extends EventEmitter {
  constructor() {
    super();
    this._providers = new Map(); // name -> provider
    this._builtinProvider = null;
    this._externalProvider = null;
    this._initialized = false;
    this._pendingSyncs = [];
    this._syncInterval = null;
  }

  /**
   * Initialize the memory manager.
   * @param {Object} config - Memory configuration
   */
  async initialize(config = {}) {
    if (this._initialized) return;

    // Register builtin provider
    const BuiltinProvider = require('./builtin-provider');
    this._builtinProvider = new BuiltinProvider();
    await this._builtinProvider.initialize('default', config.builtin || {});
    this._providers.set('builtin', this._builtinProvider);

    // Register external provider if configured
    if (config.provider && config.provider !== 'builtin') {
      await this._registerExternalProvider(config.provider, config.external || {});
    }

    // Start background sync
    this._startBackgroundSync();

    this._initialized = true;
    console.log(`[MemoryManager] Initialized with ${this._providers.size} provider(s)`);
  }

  /**
   * Register an external memory provider.
   * @param {string} providerName - Provider name
   * @param {Object} config - Provider configuration
   */
  async _registerExternalProvider(providerName, config = {}) {
    if (this._externalProvider) {
      console.warn(`[MemoryManager] External provider already registered: ${this._externalProvider.name}`);
      return false;
    }

    try {
      // Dynamic import of provider module
      // Try local providers/ directory first, then peer-level plugins
      let ProviderClass;
      try {
        ProviderClass = require(`./providers/${providerName}`);
      } catch {
        // External providers not yet installed — graceful degradation
        console.warn(`[MemoryManager] Provider module not found: ${providerName}. Install the provider plugin to enable it.`);
        return false;
      }
      const provider = new ProviderClass();

      if (await provider.isAvailable()) {
        await provider.initialize('default', config);
        this._externalProvider = provider;
        this._providers.set(providerName, provider);
        console.log(`[MemoryManager] Registered external provider: ${providerName}`);
        return true;
      } else {
        console.warn(`[MemoryManager] Provider ${providerName} not available`);
        return false;
      }
    } catch (error) {
      console.error(`[MemoryManager] Failed to register provider ${providerName}:`, error.message);
      return false;
    }
  }

  /**
   * Get all registered providers.
   * @returns {Array} - Array of provider instances
   */
  getProviders() {
    return Array.from(this._providers.values());
  }

  /**
   * Get provider by name.
   * @param {string} name - Provider name
   * @returns {Object|null} - Provider instance or null
   */
  getProvider(name) {
    return this._providers.get(name) || null;
  }

  /**
   * Get system prompt blocks from all providers.
   * @returns {string} - Combined system prompt blocks
   */
  getSystemPromptBlocks() {
    const blocks = [];
    for (const provider of this._providers.values()) {
      const block = provider.systemPromptBlock();
      if (block) blocks.push(block);
    }
    return blocks.join('\n\n');
  }

  /**
   * Prefetch context from all providers.
   * @param {string} query - User query
   * @param {string} sessionId - Session identifier
   * @returns {Promise<string>} - Combined context
   */
  async prefetchAll(query, sessionId = '') {
    const contexts = [];

    for (const provider of this._providers.values()) {
      try {
        const context = await provider.prefetch(query, sessionId);
        if (context) contexts.push(context);
      } catch (error) {
        console.error(`[MemoryManager] Prefetch failed for ${provider.name}:`, error.message);
      }
    }

    const result = contexts.join('\n\n');
    // Cache last prefetch for synchronous access
    this._lastPrefetch = result;
    return result;
  }

  /**
   * Get the last prefetched context (synchronous, from cache).
   * @returns {string} - Last prefetched context
   */
  getLastPrefetch() {
    return this._lastPrefetch || '';
  }

  /**
   * Queue background prefetch for all providers.
   * @param {string} query - User query
   * @param {string} sessionId - Session identifier
   */
  async queuePrefetchAll(query, sessionId = '') {
    for (const provider of this._providers.values()) {
      try {
        await provider.queuePrefetch(query, sessionId);
      } catch (error) {
        console.error(`[MemoryManager] Queue prefetch failed for ${provider.name}:`, error.message);
      }
    }
  }

  /**
   * Sync a completed turn to all providers.
   * @param {string} userContent - User message
   * @param {string} assistantContent - Assistant response
   * @param {string} sessionId - Session identifier
   * @param {Array} messages - Full conversation history
   */
  async syncAll(userContent, assistantContent, sessionId = '', messages = []) {
    const syncTask = async () => {
      for (const provider of this._providers.values()) {
        try {
          await provider.syncTurn(userContent, assistantContent, sessionId, messages);
        } catch (error) {
          console.error(`[MemoryManager] Sync failed for ${provider.name}:`, error.message);
        }
      }
    };

    // Add to pending syncs
    this._pendingSyncs.push(syncTask);
  }

  /**
   * Start background sync worker.
   */
  _startBackgroundSync() {
    // Process pending syncs every 100ms
    this._syncInterval = setInterval(async () => {
      if (this._pendingSyncs.length === 0) return;

      const task = this._pendingSyncs.shift();
      try {
        await task();
      } catch (error) {
        console.error('[MemoryManager] Background sync error:', error.message);
      }
    }, 100);
  }

  /**
   * Flush all pending syncs.
   * @param {number} timeout - Timeout in milliseconds
   */
  async flushPending(timeout = 5000) {
    const start = Date.now();
    while (this._pendingSyncs.length > 0 && Date.now() - start < timeout) {
      const task = this._pendingSyncs.shift();
      try {
        await task();
      } catch (error) {
        console.error('[MemoryManager] Flush error:', error.message);
      }
    }
  }

  /**
   * Notify providers of a memory write.
   * @param {string} action - "add", "replace", or "remove"
   * @param {string} target - "memory" or "user"
   * @param {string} content - Content being written
   * @param {Object} metadata - Additional metadata
   */
  async notifyMemoryWrite(action, target, content, metadata = null) {
    for (const provider of this._providers.values()) {
      try {
        await provider.onMemoryWrite(action, target, content, metadata);
      } catch (error) {
        console.error(`[MemoryManager] Memory write notification failed for ${provider.name}:`, error.message);
      }
    }
  }

  /**
   * Call onTurnStart hook on all providers.
   * @param {number} turnNumber - Current turn number
   * @param {string} message - Current user message
   * @param {Object} kwargs - Additional context
   */
  async onTurnStart(turnNumber, message, kwargs = {}) {
    for (const provider of this._providers.values()) {
      try {
        await provider.onTurnStart(turnNumber, message, kwargs);
      } catch (error) {
        console.error(`[MemoryManager] onTurnStart failed for ${provider.name}:`, error.message);
      }
    }
  }

  /**
   * Call onSessionEnd hook on all providers.
   * @param {Array} messages - Full conversation history
   */
  async onSessionEnd(messages = []) {
    for (const provider of this._providers.values()) {
      try {
        await provider.onSessionEnd(messages);
      } catch (error) {
        console.error(`[MemoryManager] onSessionEnd failed for ${provider.name}:`, error.message);
      }
    }
  }

  /**
   * Call onPreCompress hook on all providers.
   * @param {Array} messages - Messages about to be compressed
   * @returns {Promise<string>} - Combined insights
   */
  async onPreCompress(messages = []) {
    const insights = [];

    for (const provider of this._providers.values()) {
      try {
        const providerInsights = await provider.onPreCompress(messages);
        if (providerInsights) insights.push(providerInsights);
      } catch (error) {
        console.error(`[MemoryManager] onPreCompress failed for ${provider.name}:`, error.message);
      }
    }

    return insights.join('\n\n');
  }

  /**
   * Call onDelegation hook on all providers.
   * @param {string} task - Delegated task description
   * @param {string} result - Task result
   * @param {string} childSessionId - Child session identifier
   */
  async onDelegation(task, result, childSessionId = '', kwargs = {}) {
    for (const provider of this._providers.values()) {
      try {
        await provider.onDelegation(task, result, childSessionId, kwargs);
      } catch (error) {
        console.error(`[MemoryManager] onDelegation failed for ${provider.name}:`, error.message);
      }
    }
  }

  /**
   * Shutdown all providers and stop background sync.
   */
  async shutdown() {
    // Stop background sync
    if (this._syncInterval) {
      clearInterval(this._syncInterval);
      this._syncInterval = null;
    }

    // Flush pending syncs
    await this.flushPending(2000);

    // Shutdown providers in reverse order
    const providers = Array.from(this._providers.values()).reverse();
    for (const provider of providers) {
      try {
        await provider.shutdown();
      } catch (error) {
        console.error(`[MemoryManager] Shutdown failed for ${provider.name}:`, error.message);
      }
    }

    this._providers.clear();
    this._builtinProvider = null;
    this._externalProvider = null;
    this._initialized = false;
    console.log('[MemoryManager] Shut down');
  }

  /**
   * Get status of all providers.
   * @returns {Object} - Status information
   */
  async getStatus() {
    const providerStatus = [];
    for (const [name, provider] of this._providers) {
      let available = false;
      try {
        available = await provider.isAvailable();
      } catch {}
      providerStatus.push({ name, available });
    }

    return {
      initialized: this._initialized,
      providers: providerStatus,
      pendingSyncs: this._pendingSyncs.length
    };
  }
}

// Singleton instance
let _instance = null;

function getMemoryManager() {
  if (!_instance) {
    _instance = new MemoryManager();
  }
  return _instance;
}

module.exports = {
  MemoryManager,
  getMemoryManager
};
