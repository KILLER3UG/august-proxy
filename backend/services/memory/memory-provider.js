/**
 * memory-provider.js — Abstract base class for memory providers.
 * Inspired by Hermes's memory_provider.py pattern.
 *
 * Defines the contract for pluggable memory backends.
 * External providers extend this class and register with MemoryManager.
 */

/**
 * Abstract MemoryProvider base class.
 * External providers must implement all abstract methods.
 */
class MemoryProvider {
  /**
   * @param {string} name - Short identifier (e.g., "builtin", "honcho", "mem0")
   */
  constructor(name) {
    if (new.target === MemoryProvider) {
      throw new Error('MemoryProvider is abstract and cannot be instantiated directly');
    }
    this._name = name;
    this._initialized = false;
  }

  /**
   * Provider name identifier.
   */
  get name() {
    return this._name;
  }

  /**
   * Check if provider is available (config/credentials present).
   * Should NOT make network calls.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    throw new Error('isAvailable() must be implemented by subclass');
  }

  /**
   * Initialize the provider (connect, create resources).
   * @param {string} sessionId - Current session identifier
   * @param {Object} config - Provider configuration
   */
  async initialize(sessionId, config = {}) {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Static text to inject into system prompt.
   * @returns {string}
   */
  systemPromptBlock() {
    return '';
  }

  /**
   * Recall relevant context before each turn.
   * @param {string} query - User query or context
   * @param {string} sessionId - Current session identifier
   * @returns {Promise<string>} - Retrieved context
   */
  async prefetch(query, sessionId = '') {
    return '';
  }

  /**
   * Queue background recall for NEXT turn (non-blocking).
   * @param {string} query - User query or context
   * @param {string} sessionId - Current session identifier
   */
  async queuePrefetch(query, sessionId = '') {
    // Default: no-op
  }

  /**
   * Persist a completed turn to the provider.
   * @param {string} userContent - User message
   * @param {string} assistantContent - Assistant response
   * @param {string} sessionId - Current session identifier
   * @param {Array} messages - Full conversation history (optional)
   */
  async syncTurn(userContent, assistantContent, sessionId = '', messages = []) {
    throw new Error('syncTurn() must be implemented by subclass');
  }

  /**
   * Get tool schemas for this provider (OpenAI function calling format).
   * @returns {Array} - Array of tool schemas
   */
  getToolSchemas() {
    return [];
  }

  /**
   * Handle a tool call from the model.
   * @param {string} toolName - Name of the tool
   * @param {Object} args - Tool arguments
   * @returns {Promise<any>} - Tool result
   */
  async handleToolCall(toolName, args) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  /**
   * Clean shutdown of the provider.
   */
  async shutdown() {
    this._initialized = false;
  }

  // ── Optional Hooks ──

  /**
   * Per-turn tick with runtime context.
   * @param {number} turnNumber - Current turn number
   * @param {string} message - Current user message
   * @param {Object} kwargs - Additional context (remaining_tokens, model, platform, tool_count)
   */
  async onTurnStart(turnNumber, message, kwargs = {}) {
    // Default: no-op
  }

  /**
   * End-of-session fact extraction.
   * @param {Array} messages - Full conversation history
   */
  async onSessionEnd(messages = []) {
    // Default: no-op
  }

  /**
   * Session switch handler.
   * @param {string} newSessionId - New session identifier
   * @param {string} parentSessionId - Parent session (for branching)
   * @param {boolean} reset - Whether this is a full reset
   * @param {boolean} rewound - Whether session was rewound
   */
  async onSessionSwitch(newSessionId, parentSessionId = '', reset = false, rewound = false) {
    // Default: no-op
  }

  /**
   * Extract insights before context compression.
   * @param {Array} messages - Messages about to be compressed
   * @returns {Promise<string>} - Insights to preserve
   */
  async onPreCompress(messages = []) {
    return '';
  }

  /**
   * Mirror built-in memory writes to external backend.
   * @param {string} action - "add", "replace", or "remove"
   * @param {string} target - "memory" or "user"
   * @param {string} content - Content being written
   * @param {Object} metadata - Additional metadata
   */
  async onMemoryWrite(action, target, content, metadata = null) {
    // Default: no-op
  }

  /**
   * Parent-side observation of subagent work.
   * @param {string} task - Delegated task description
   * @param {string} result - Task result
   * @param {string} childSessionId - Child session identifier
   */
  async onDelegation(task, result, childSessionId = '', kwargs = {}) {
    // Default: no-op
  }

  /**
   * Get extra on-disk paths for backup.
   * @returns {string[]} - Array of file paths
   */
  backupPaths() {
    return [];
  }

  /**
   * Get config schema for setup UI.
   * @returns {Array} - Array of config field definitions
   */
  getConfigSchema() {
    return [];
  }

  /**
   * Save non-secret config to native location.
   * @param {Object} values - Config values to save
   * @param {string} homeDir - Home directory path
   */
  async saveConfig(values, homeDir) {
    // Default: no-op
  }
}

module.exports = MemoryProvider;
