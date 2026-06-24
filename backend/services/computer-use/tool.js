/**
 * tool.js — Computer use tool with approval workflow.
 * Inspired by Hermes's computer_use/tool.py pattern.
 *
 * Registers the computer_use tool with the tool registry.
 * Implements safe action approval and dangerous action blocking.
 */

const { z } = require('zod');
const CuaBackend = require('./cua-backend');
const { Point } = require('./backend');

// ── Configuration ──

function getConfig() {
  try {
    const { getConfig } = require('../../lib/config');
    const config = getConfig();
    return config.computer_use || {};
  } catch {
    return {};
  }
}

// ── Approval Workflow ──

const SAFE_ACTIONS = ['capture', 'list_apps', 'health'];
const DANGEROUS_ACTIONS = ['click', 'type', 'key', 'drag', 'scroll', 'focus_app'];

const BLOCKED_KEY_COMBOS = [
  'Cmd+Shift+Backspace',
  'Win+L',
  'Ctrl+Alt+Delete',
  'Alt+F4',
  'Cmd+Q'
];

const BLOCKED_TYPE_PATTERNS = [
  /curl\s*\|\s*bash/i,
  /rm\s+-rf\s+\//i,
  /sudo\s+rm/i,
  /mkfs/i,
  /dd\s+if=/i,
  />\/dev\/sd/i
];

// ── Backend Singleton ──

let _backend = null;
let _approvalCallback = null;

/**
 * Get or create the CUA backend instance.
 */
async function getBackend() {
  if (!_backend) {
    _backend = new CuaBackend();
    try {
      await _backend.initialize();
    } catch (error) {
      console.error('[ComputerUse] Failed to initialize backend:', error.message);
      _backend = null;
      throw error;
    }
  }
  return _backend;
}

/**
 * Set the approval callback function.
 * @param {Function} callback - async (action, params) => boolean
 */
function setApprovalCallback(callback) {
  _approvalCallback = callback;
}

/**
 * Check if an action requires approval.
 */
function requiresApproval(action, params) {
  if (SAFE_ACTIONS.includes(action)) return false;
  if (DANGEROUS_ACTIONS.includes(action)) return true;
  return false;
}

/**
 * Check if an action is blocked.
 */
function isBlocked(action, params) {
  // Block dangerous key combos
  if (action === 'key' && params.key) {
    if (BLOCKED_KEY_COMBOS.includes(params.key)) {
      return { blocked: true, reason: `Blocked dangerous key combo: ${params.key}` };
    }
  }

  // Block dangerous type patterns
  if (action === 'type' && params.text) {
    for (const pattern of BLOCKED_TYPE_PATTERNS) {
      if (pattern.test(params.text)) {
        return { blocked: true, reason: `Blocked dangerous type pattern: ${params.text}` };
      }
    }
  }

  return { blocked: false };
}

/**
 * Request approval for an action.
 */
async function requestApproval(action, params) {
  if (!requiresApproval(action, params)) {
    return true;
  }

  if (!_approvalCallback) {
    console.warn(`[ComputerUse] No approval callback set, auto-approving ${action}`);
    return true;
  }

  try {
    return await _approvalCallback(action, params);
  } catch (error) {
    console.error(`[ComputerUse] Approval callback error:`, error.message);
    return false;
  }
}

// ── Tool Schema ──

const computerUseSchema = z.object({
  action: z.enum([
    'capture',
    'click',
    'drag',
    'scroll',
    'type',
    'key',
    'list_apps',
    'focus_app',
    'health'
  ]),
  element_index: z.number().optional(),
  from: z.object({ x: z.number(), y: z.number() }).optional(),
  to: z.object({ x: z.number(), y: z.number() }).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  app_id: z.string().optional()
});

// ── Tool Handler ──

async function computerUseHandler(args, ctx = {}) {
  const { action, element_index, from, to, direction, amount, text, key, app_id } = args;

  // Check if blocked
  const blocked = isBlocked(action, args);
  if (blocked.blocked) {
    return { error: blocked.reason };
  }

  // Request approval
  const approved = await requestApproval(action, args);
  if (!approved) {
    return { error: 'Action not approved by user' };
  }

  // Get backend
  let backend;
  try {
    backend = await getBackend();
  } catch (error) {
    return { error: `Backend initialization failed: ${error.message}` };
  }

  // Execute action
  try {
    switch (action) {
      case 'capture': {
        const result = await backend.capture();
        return {
          elements: result.elements.map(el => ({
            index: el.index,
            label: el.label,
            role: el.role,
            bounds: {
              x: el.bounds.x,
              y: el.bounds.y,
              width: el.bounds.width,
              height: el.bounds.height
            },
            interactive: el.interactive
          })),
          width: result.width,
          height: result.height,
          timestamp: result.timestamp
        };
      }

      case 'click': {
        if (element_index === undefined) {
          return { error: 'element_index is required for click action' };
        }
        const result = await backend.click(element_index);
        return {
          success: result.success,
          message: result.message,
          elements: result.elements?.map(el => ({
            index: el.index,
            label: el.label,
            role: el.role
          }))
        };
      }

      case 'drag': {
        if (!from || !to) {
          return { error: 'from and to positions are required for drag action' };
        }
        const result = await backend.drag(new Point(from.x, from.y), new Point(to.x, to.y));
        return {
          success: result.success,
          message: result.message
        };
      }

      case 'scroll': {
        if (!direction) {
          return { error: 'direction is required for scroll action' };
        }
        const result = await backend.scroll(direction, amount || 100);
        return {
          success: result.success,
          message: result.message
        };
      }

      case 'type': {
        if (!text) {
          return { error: 'text is required for type action' };
        }
        const result = await backend.typeText(text);
        return {
          success: result.success,
          message: result.message
        };
      }

      case 'key': {
        if (!key) {
          return { error: 'key is required for key action' };
        }
        const result = await backend.key(key);
        return {
          success: result.success,
          message: result.message
        };
      }

      case 'list_apps': {
        const apps = await backend.listApps();
        return {
          apps: apps.map(app => ({
            id: app.id,
            name: app.name,
            pid: app.pid,
            focused: app.focused
          }))
        };
      }

      case 'focus_app': {
        if (!app_id) {
          return { error: 'app_id is required for focus_app action' };
        }
        const result = await backend.focusApp(app_id);
        return {
          success: result.success,
          message: result.message
        };
      }

      case 'health': {
        const status = await backend.healthCheck();
        return {
          healthy: status.healthy,
          platform: status.platform,
          backend: status.backend,
          message: status.message,
          details: status.details
        };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (error) {
    return { error: `Action failed: ${error.message}` };
  }
}

// ── Tool Registration ──

function registerComputerUseTool(toolRegistry) {
  const config = getConfig();

  // Only register if enabled
  if (config.enabled === false) {
    console.log('[ComputerUse] Disabled in config, not registering tool');
    return;
  }

  toolRegistry.register({
    name: 'computer_use',
    description: 'Capture screen, interact with UI elements via SOM overlay, type text, press keys, and control desktop applications.',
    schema: computerUseSchema,
    handler: computerUseHandler,
    toolset: 'computer_use',
    permissions: { category: 'write', destructive: true },
    emoji: '🖥️',
    checkFn: () => {
      // Check if backend binary is available
      try {
        const config = getConfig();
        const backend = new CuaBackend();
        backend._config = config;
        return backend._findBinary() !== null;
      } catch {
        return false;
      }
    },
    metadata: {
      requiresApproval: true,
      safeActions: SAFE_ACTIONS,
      dangerousActions: DANGEROUS_ACTIONS
    }
  });

  console.log('[ComputerUse] Tool registered');
}

module.exports = {
  registerComputerUseTool,
  setApprovalCallback,
  getBackend,
  requiresApproval,
  isBlocked,
  SAFE_ACTIONS,
  DANGEROUS_ACTIONS,
  BLOCKED_KEY_COMBOS,
  BLOCKED_TYPE_PATTERNS
};
