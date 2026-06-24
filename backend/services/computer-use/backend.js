/**
 * backend.js — Abstract backend for computer use.
 * Inspired by Hermes's computer_use/backend.py pattern.
 *
 * Defines the contract for computer use backends.
 * Supports cross-platform desktop automation with SOM overlay.
 */

/**
 * Abstract ComputerUseBackend base class.
 * Concrete backends must implement all abstract methods.
 */
class ComputerUseBackend {
  constructor() {
    if (new.target === ComputerUseBackend) {
      throw new Error('ComputerUseBackend is abstract and cannot be instantiated directly');
    }
    this._initialized = false;
  }

  /**
   * Initialize the backend.
   * @param {Object} config - Backend configuration
   */
  async initialize(config = {}) {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Capture the current screen state.
   * @returns {Promise<CaptureResult>} - Screenshot with UI elements
   */
  async capture() {
    throw new Error('capture() must be implemented by subclass');
  }

  /**
   * Click on a UI element by index.
   * @param {number} elementIndex - Index of element from SOM overlay
   * @returns {Promise<ActionResult>} - Action result
   */
  async click(elementIndex) {
    throw new Error('click() must be implemented by subclass');
  }

  /**
   * Drag from one point to another.
   * @param {Point} from - Start position
   * @param {Point} to - End position
   * @returns {Promise<ActionResult>} - Action result
   */
  async drag(from, to) {
    throw new Error('drag() must be implemented by subclass');
  }

  /**
   * Scroll the screen.
   * @param {'up'|'down'|'left'|'right'} direction - Scroll direction
   * @param {number} amount - Scroll amount in pixels
   * @returns {Promise<ActionResult>} - Action result
   */
  async scroll(direction, amount) {
    throw new Error('scroll() must be implemented by subclass');
  }

  /**
   * Type text at the current cursor position.
   * @param {string} text - Text to type
   * @returns {Promise<ActionResult>} - Action result
   */
  async typeText(text) {
    throw new Error('typeText() must be implemented by subclass');
  }

  /**
   * Press a key or key combination.
   * @param {string} keyCombo - Key combination (e.g., "Ctrl+C", "Enter")
   * @returns {Promise<ActionResult>} - Action result
   */
  async key(keyCombo) {
    throw new Error('key() must be implemented by subclass');
  }

  /**
   * List running applications.
   * @returns {Promise<Array<AppInfo>>} - List of running apps
   */
  async listApps() {
    throw new Error('listApps() must be implemented by subclass');
  }

  /**
   * Focus a specific application.
   * @param {string} appId - Application identifier
   * @returns {Promise<ActionResult>} - Action result
   */
  async focusApp(appId) {
    throw new Error('focusApp() must be implemented by subclass');
  }

  /**
   * Get backend health status.
   * @returns {Promise<HealthStatus>} - Health status
   */
  async healthCheck() {
    throw new Error('healthCheck() must be implemented by subclass');
  }

  /**
   * Clean shutdown of the backend.
   */
  async shutdown() {
    this._initialized = false;
  }
}

// ── Data Classes ──

/**
 * Point position on screen.
 */
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

/**
 * Rectangle bounds on screen.
 */
class Rectangle {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  contains(point) {
    return point.x >= this.x && point.x <= this.x + this.width &&
           point.y >= this.y && point.y <= this.y + this.height;
  }

  center() {
    return new Point(this.x + this.width / 2, this.y + this.height / 2);
  }
}

/**
 * UI element detected on screen.
 */
class UIElement {
  constructor(opts) {
    this.index = opts.index || 0;
    this.label = opts.label || '';
    this.role = opts.role || '';
    this.bounds = opts.bounds || new Rectangle(0, 0, 0, 0);
    this.interactive = opts.interactive !== false;
    this.value = opts.value || null;
    this.description = opts.description || '';
  }
}

/**
 * Result of screen capture.
 */
class CaptureResult {
  constructor(opts) {
    this.screenshot = opts.screenshot || null; // Buffer or base64
    this.elements = opts.elements || [];
    this.width = opts.width || 0;
    this.height = opts.height || 0;
    this.timestamp = opts.timestamp || new Date().toISOString();
    this.somOverlay = opts.somOverlay || null; // SOM overlay image
  }
}

/**
 * Result of a UI action.
 */
class ActionResult {
  constructor(opts) {
    this.success = opts.success !== false;
    this.message = opts.message || '';
    this.elements = opts.elements || []; // Updated elements after action
    this.screenshot = opts.screenshot || null; // Post-action screenshot
  }
}

/**
 * Application information.
 */
class AppInfo {
  constructor(opts) {
    this.id = opts.id || '';
    this.name = opts.name || '';
    this.pid = opts.pid || 0;
    this.focused = opts.focused || false;
    this.bounds = opts.bounds || null;
  }
}

/**
 * Backend health status.
 */
class HealthStatus {
  constructor(opts) {
    this.healthy = opts.healthy !== false;
    this.platform = opts.platform || process.platform;
    this.backend = opts.backend || 'unknown';
    this.message = opts.message || '';
    this.details = opts.details || {};
  }
}

module.exports = {
  ComputerUseBackend,
  Point,
  Rectangle,
  UIElement,
  CaptureResult,
  ActionResult,
  AppInfo,
  HealthStatus
};
