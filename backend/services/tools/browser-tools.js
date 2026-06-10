/**
 * hermes-browser.js — Full browser automation via Playwright.
 * Provides Hermes-style browser tools for the August Proxy.
 *
 * Tools: browser_navigate, browser_snapshot, browser_click,
 *        browser_type, browser_scroll, browser_back, browser_press,
 *        browser_console, browser_get_images, browser_vision.
 *
 * Sessions are managed per task_id (string) so multiple independent
 * browser contexts can coexist. Falls back to puppeteer if Playwright
 * is unavailable (see try/catch at the bottom).
 *
 * Exports:
 *   toolDefinitions  — Array of tool configs for register()
 *   handlers         — { name -> async (args) => result } for direct dispatch
 *   cleanup          — Close all browser instances
 *   registerBrowserTools(registry) — Register all tools with a registry
 */

const { z } = require('zod');
const path = require('path');
const fs = require('fs');

// ── Browser engine selection ──

let playwright = null;
let puppeteer = null;
let engine = null; // 'playwright' | 'puppeteer' | null

function resolveEngine() {
  if (engine) return engine;
  // Try Playwright first (preferred)
  try {
    playwright = require('playwright');
    engine = 'playwright';
    return engine;
  } catch (_e) {
    // fall through
  }
  // Try Puppeteer as fallback
  try {
    puppeteer = require('puppeteer');
    engine = 'puppeteer';
    return engine;
  } catch (_e) {
    engine = 'none';
    return engine;
  }
}

// ── Session state ──

/**
 * Map<task_id, { browser, context, page, consoleLogs, lastSnapshot }>
 */
const sessions = new Map();

const DEFAULT_TASK_ID = 'default';

function resolveTaskId(taskId) {
  return String(taskId || DEFAULT_TASK_ID);
}

// ── Browser management ──

async function getOrCreateSession(taskId) {
  const tid = resolveTaskId(taskId);
  if (sessions.has(tid)) {
    return sessions.get(tid);
  }

  const resolved = resolveEngine();
  if (resolved === 'none') {
    throw new Error('No browser automation engine available. Install Playwright ("npm install playwright" + "npx playwright install chromium") or Puppeteer.');
  }

  let browser;
  let context;
  let page;

  if (resolved === 'playwright') {
    const browserType = (process.env.BROWSER_ENGINE || 'chromium').toLowerCase();
    const launcher = playwright[browserType] || playwright.chromium;
    browser = await launcher.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    context.on('page', (p) => { page = p; });
    page = await context.newPage();

    // Collect console messages
    const consoleLogs = [];
    page.on('console', (msg) => {
      consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      // Keep last 500 entries
      if (consoleLogs.length > 500) consoleLogs.splice(0, consoleLogs.length - 500);
    });

    const session = { browser, context, page, consoleLogs, lastSnapshot: null };
    sessions.set(tid, session);
    return session;
  }

  // Puppeteer fallback
  if (resolved === 'puppeteer') {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const consoleLogs = [];
    page.on('console', (msg) => {
      consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      if (consoleLogs.length > 500) consoleLogs.splice(0, consoleLogs.length - 500);
    });

    // Puppeteer doesn't have formal 'context', but we keep an alias
    const session = { browser, context: null, page, consoleLogs, lastSnapshot: null };
    sessions.set(tid, session);
    return session;
  }

  throw new Error('Unreachable: no engine resolved');
}

async function getSession(taskId) {
  const tid = resolveTaskId(taskId);
  if (!sessions.has(tid)) {
    return null;
  }
  return sessions.get(tid);
}

async function ensurePage(taskId) {
  const session = await getOrCreateSession(taskId);
  if (!session.page) {
    if (engine === 'puppeteer') {
      session.page = await session.browser.newPage();
    } else {
      session.page = await session.context.newPage();
    }
  }
  return session;
}

// ── DOM-based snapshot (alternative to deprecated Playwright accessibility API) ──

/**
 * Walk the DOM via page.evaluate to collect interactive elements.
 * Returns an array similar to what flattenAccessibilityTree expects.
 */
function domSnapshotScript() { // eslint-disable-line no-unused-vars
  var interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY'];
  var interactiveRoles = [
    'button', 'link', 'textbox', 'combobox', 'listbox', 'menuitem',
    'checkbox', 'radio', 'switch', 'tab', 'treeitem', 'searchbox',
    'spinbutton', 'slider', 'option', 'progressbar', 'scrollbar', 'tabpanel',
  ];
  var tagToRole = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'listbox',
    TEXTAREA: 'textbox', DETAILS: 'group', SUMMARY: 'button',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
    ASIDE: 'complementary', FORM: 'form', TABLE: 'table', IMG: 'img',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    UL: 'list', OL: 'list', LI: 'listitem',
  };
  var result = [];
  var counter = 0;
  function walk(node, depth) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    var el = node;
    var tag = el.tagName;
    var explicitRole = el.getAttribute('role');
    var role = explicitRole || tagToRole[tag] || tag.toLowerCase();
    var isInteractive = interactiveTags.indexOf(tag) >= 0 ||
      interactiveRoles.indexOf(role) >= 0 ||
      (tag === 'IMG' && el.hasAttribute('alt')) ||
      (tag === 'IFRAME') ||
      el.hasAttribute('tabindex') || el.hasAttribute('onclick') ||
      el.getAttribute('contenteditable') === 'true' ||
      (el.style && el.style.cursor === 'pointer');
    if (isInteractive || explicitRole || tagToRole[tag]) {
      counter++;
      result.push({
        ref: '@e' + counter,
        role: role,
        name: el.getAttribute('aria-label') || (el.textContent ? el.textContent.trim().slice(0, 200) : '') || '',
        value: el.value !== undefined ? String(el.value).slice(0, 120) : '',
        description: el.getAttribute('aria-description') || el.title || '',
        path: '',
        depth: depth,
        focused: document.activeElement === el,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        checked: el.getAttribute('aria-checked'),
        selected: el.getAttribute('aria-selected'),
        expanded: el.getAttribute('aria-expanded'),
        level: el.getAttribute('aria-level') || (tag.match(/^H([1-6])$/) ? tag[1] : null),
        roledescription: '',
        tag: tag.toLowerCase(),
        selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : ''),
      });
    }
    for (var i = 0; i < el.children.length; i++) {
      walk(el.children[i], depth + 1);
    }
  }
  walk(document.body, 0);
  return result;
}

/**
 * Take a snapshot via DOM evaluation (works when Playwright accessibility API is unavailable).
 */
async function domSnapshot(page) {
  return await page.evaluate(domSnapshotScript);
}

/**
 * Flatten the Playwright accessibility tree into a list of elements
 * with ref IDs like "@e1", "@e2", etc.
 * Each element includes: ref, role, name, value, description, selector hints.
 */
function flattenAccessibilityTree(node, path = 'root', depth = 0, refCounter = { count: 0 }) {
  const result = [];
  if (!node) return result;

  refCounter.count++;
  const ref = `@e${refCounter.count}`;
  const entry = {
    ref,
    role: node.role || 'unknown',
    name: node.name || '',
    value: node.value || node.valueText || '',
    description: node.description || '',
    path: path || '',
    depth,
    focused: node.focused || false,
    disabled: node.disabled || false,
    checked: node.checked || null,
    selected: node.selected || null,
    expanded: node.expanded || null,
    level: node.level || null,
    roledescription: node.roledescription || '',
  };

  result.push(entry);

  if (node.children && Array.isArray(node.children)) {
    node.children.forEach((child, idx) => {
      const childPath = `${path} > ${child.role || '?'}[${idx}]`;
      result.push(...flattenAccessibilityTree(child, childPath, depth + 1, refCounter));
    });
  }

  return result;
}

/**
 * Build a compact text snapshot of interactive elements only.
 * This matches the Hermes browser_snapshot compact mode.
 */
function buildCompactSnapshot(elements) {
  const lines = [];
  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'combobox', 'listbox', 'menuitem',
    'checkbox', 'radio', 'switch', 'tab', 'treeitem', 'searchbox',
    'spinbutton', 'slider', 'menuitemcheckbox', 'menuitemradio',
    'option', 'progressbar', 'scrollbar', 'tabpanel',
  ]);

  for (const el of elements) {
    if (!interactiveRoles.has(el.role) && el.role !== 'text' && el.role !== 'heading') continue;
    const parts = [`[${el.ref}]`];
    if (el.role) parts.push(el.role);
    if (el.name) parts.push(JSON.stringify(el.name.slice(0, 120)));
    if (el.value) parts.push(`value=${JSON.stringify(el.value.slice(0, 80))}`);
    if (el.description) parts.push(`desc=${JSON.stringify(el.description.slice(0, 80))}`);
    lines.push(parts.join(' '));
  }

  return lines.join('\n');
}

/**
 * Build a verbose (full) accessibility tree snapshot.
 */
function buildFullSnapshot(elements) {
  const lines = [];

  for (const el of elements) {
    const indent = '  '.repeat(el.depth);
    const parts = [`${indent}[${el.ref}]`];
    if (el.role) parts.push(`<${el.role}>`);
    if (el.name) parts.push(JSON.stringify(el.name.slice(0, 200)));
    if (el.value) parts.push(`value=${JSON.stringify(el.value.slice(0, 120))}`);
    if (el.description) parts.push(`desc=${JSON.stringify(el.description.slice(0, 120))}`);
    if (el.focused) parts.push('[focused]');
    if (el.disabled) parts.push('[disabled]');
    if (el.checked !== null) parts.push(`checked=${el.checked}`);
    if (el.selected !== null) parts.push(`selected=${el.selected}`);
    if (el.expanded !== null) parts.push(`expanded=${el.expanded}`);
    if (el.level !== null) parts.push(`level=${el.level}`);

    lines.push(parts.join(' '));
  }

  return lines.join('\n');
}

/**
 * Find an element tree node by ref ID.
 */
function findNodeByRef(elements, ref) {
  return elements.find((el) => el.ref === ref) || null;
}

// ── Tool: browser_navigate ──

const NAVIGATE_SCHEMA = z.object({
  url: z.string().url({ message: 'Must be a valid URL starting with http:// or https://' }).describe('The URL to navigate to'),
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserNavigateHandler(args) {
  const { url, task_id } = args;
  try {
    const session = await ensurePage(task_id);
    const page = session.page;

    // Reset console logs on navigation
    session.consoleLogs = [];

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait a bit for dynamic content
    await page.waitForTimeout(1000);

    const title = await page.title();
    const currentUrl = page.url();

    // After navigation, take DOM-based snapshot
    session.lastSnapshot = await domSnapshot(page);

    return {
      success: true,
      title: title || '',
      url: currentUrl,
      task_id: resolveTaskId(task_id),
      message: `Navigated to ${currentUrl}`,
    };
  } catch (e) {
    return {
      success: false,
      error: `Navigation failed: ${e.message}`,
      url,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_snapshot ──

const SNAPSHOT_SCHEMA = z.object({
  full: z.boolean().optional().default(false).describe('If true, returns the full accessibility tree. If false (default), returns only interactive elements in compact format.'),
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserSnapshotHandler(args) {
  const { full, task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session) {
      return {
        error: 'No active browser session. Use browser_navigate first to start a session.',
        task_id: resolveTaskId(task_id),
        active_sessions: Array.from(sessions.keys()),
      };
    }

    const page = session.page;
    if (!page) {
      return { error: 'No active page in session.', task_id: resolveTaskId(task_id) };
    }

    // Refresh snapshot via DOM
    const elements = await domSnapshot(page);

    session.lastSnapshot = elements;
    const url = page.url();

    if (full) {
      const tree = buildFullSnapshot(elements);
      return {
        full: true,
        element_count: elements.length,
        url,
        task_id: resolveTaskId(task_id),
        snapshot: tree,
      };
    }

    const compact = buildCompactSnapshot(elements);
    return {
      full: false,
      element_count: elements.length,
      interactive_count: compact.split('\n').filter(l => l.trim()).length,
      url,
      task_id: resolveTaskId(task_id),
      snapshot: compact,
    };
  } catch (e) {
    return {
      error: `Snapshot failed: ${e.message}`,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_click ──

const CLICK_SCHEMA = z.object({
  ref: z.string().min(1).describe('The element ref ID from the snapshot (e.g. @e5)'),
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserClickHandler(args) {
  const { ref, task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session || !session.page) {
      return { error: 'No active browser session. Use browser_navigate first.', task_id: resolveTaskId(task_id) };
    }

    const page = session.page;
    const elements = session.lastSnapshot;
    if (!elements || elements.length === 0) {
      return { error: 'No accessibility snapshot available. Call browser_snapshot first.', task_id: resolveTaskId(task_id) };
    }

    const target = findNodeByRef(elements, ref);
    if (!target) {
      return {
        error: `Element ${ref} not found in snapshot. The page may have changed; call browser_snapshot again.`,
        available_refs: elements.slice(0, 20).map(e => e.ref),
        task_id: resolveTaskId(task_id),
      };
    }

    // Try to click by role + name combination using Playwright's getByRole
    if (engine === 'playwright') {
      try {
        const role = target.role;
        const name = target.name;

        if (role && name) {
          // Map accessibility roles to Playwright roles
          const roleMap = {
            'button': 'button',
            'link': 'link',
            'textbox': 'textbox',
            'combobox': 'combobox',
            'checkbox': 'checkbox',
            'radio': 'radio',
            'switch': 'switch',
            'tab': 'tab',
            'menuitem': 'menuitem',
            'listbox': 'listbox',
            'option': 'option',
            'searchbox': 'searchbox',
            'spinbutton': 'spinbutton',
            'slider': 'slider',
            'treeitem': 'treeitem',
          };
          const pwRole = roleMap[role];
          if (pwRole) {
            await page.getByRole(pwRole, { name }).click({ timeout: 5000 });
            await page.waitForTimeout(300);
            return {
              success: true,
              ref,
              role: target.role,
              name: target.name,
              url: page.url(),
              task_id: resolveTaskId(task_id),
              message: `Clicked ${ref} (<${target.role}> "${target.name}")`,
            };
          }
        }
      } catch (_e) {
        // Fallback to generic click approach
      }
    }

    // Fallback: try to find element by text content or role via DOM query
    try {
      // Build a selector from the accessible name and role
      let selector = null;
      if (target.role && target.name) {
        // Try aria-label or text content
        const roleTagMap = {
          'button': 'button',
          'link': 'a',
          'textbox': 'input, textarea',
          'combobox': 'select, input',
          'checkbox': 'input[type="checkbox"]',
          'radio': 'input[type="radio"]',
          'heading': 'h1, h2, h3, h4, h5, h6',
          'image': 'img',
          'listbox': 'select',
          'option': 'option',
          'searchbox': 'input[type="search"]',
        };
        const tags = roleTagMap[target.role] || '*';
        // Try using aria-label first
        selector = `${tags}[aria-label="${target.name.replace(/"/g, '\\"')}"]`;
        let el = await page.$(selector);
        if (!el) {
          // Try by text content
          selector = `text="${target.name}"`;
          el = await page.$(selector);
        }
        if (el) {
          await el.click();
          await page.waitForTimeout(300);
          return {
            success: true,
            ref,
            role: target.role,
            name: target.name,
            url: page.url(),
            task_id: resolveTaskId(task_id),
            message: `Clicked ${ref} (<${target.role}> "${target.name}")`,
          };
        }
      }

      // Last resort: click at the center of the viewport
      // (this is a best-effort approach)
      return {
        error: `Could not locate element ${ref} (<${target.role}> "${target.name}") on the page. The page layout may have changed. Try browser_snapshot again.`,
        ref,
        role: target.role,
        name: target.name,
        task_id: resolveTaskId(task_id),
      };
    } catch (e2) {
      return {
        error: `Failed to click ${ref}: ${e2.message}`,
        ref,
        task_id: resolveTaskId(task_id),
      };
    }
  } catch (e) {
    return {
      error: `Click failed: ${e.message}`,
      ref,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_type ──

const TYPE_SCHEMA = z.object({
  ref: z.string().min(1).describe('The element ref ID from the snapshot (e.g. @e5)'),
  text: z.string().describe('The text to type into the element'),
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserTypeHandler(args) {
  const { ref, text, task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session || !session.page) {
      return { error: 'No active browser session. Use browser_navigate first.', task_id: resolveTaskId(task_id) };
    }

    const page = session.page;
    const elements = session.lastSnapshot;
    if (!elements || elements.length === 0) {
      return { error: 'No accessibility snapshot available. Call browser_snapshot first.', task_id: resolveTaskId(task_id) };
    }

    const target = findNodeByRef(elements, ref);
    if (!target) {
      return {
        error: `Element ${ref} not found in snapshot.`,
        available_refs: elements.slice(0, 20).map(e => e.ref),
        task_id: resolveTaskId(task_id),
      };
    }

    // Try Playwright getByRole
    if (engine === 'playwright') {
      try {
        if (target.role && target.name) {
          await page.getByRole('textbox', { name: target.name }).fill(text, { timeout: 5000 });
          await page.waitForTimeout(200);
          return {
            success: true,
            ref,
            typed_length: text.length,
            task_id: resolveTaskId(task_id),
            message: `Typed ${text.length} characters into ${ref}`,
          };
        }
      } catch (_e) {
        // Fall through
      }
    }

    // Fallback: try locating by aria-label or placeholder
    try {
      let selector = `[aria-label="${target.name.replace(/"/g, '\\"')}"]`;
      let el = await page.$(selector);
      if (!el) {
        selector = `[placeholder="${target.name.replace(/"/g, '\\"')}"]`;
        el = await page.$(selector);
      }
      if (!el) {
        selector = 'input, textarea, [contenteditable="true"]';
        el = await page.$(selector);
      }
      if (el) {
        await el.click();
        await el.fill('');
        await el.type(text, { delay: 10 });
        await page.waitForTimeout(200);
        return {
          success: true,
          ref,
          typed_length: text.length,
          task_id: resolveTaskId(task_id),
          message: `Typed ${text.length} characters into ${ref}`,
        };
      }

      return {
        error: `Could not locate an input field matching ${ref} (<${target.role}> "${target.name}")`,
        ref,
        role: target.role,
        name: target.name,
        task_id: resolveTaskId(task_id),
      };
    } catch (e2) {
      return {
        error: `Failed to type into ${ref}: ${e2.message}`,
        ref,
        task_id: resolveTaskId(task_id),
      };
    }
  } catch (e) {
    return {
      error: `Type failed: ${e.message}`,
      ref,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_scroll ──

const SCROLL_SCHEMA = z.object({
  direction: z.enum(['up', 'down']).describe('Direction to scroll the page'),
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserScrollHandler(args) {
  const { direction, task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session || !session.page) {
      return { error: 'No active browser session. Use browser_navigate first.', task_id: resolveTaskId(task_id) };
    }

    const page = session.page;
    const scrollAmount = direction === 'down' ? 800 : -800;

    await page.evaluate((amount) => {
      window.scrollBy({ top: amount, left: 0, behavior: 'smooth' });
    }, scrollAmount);

    await page.waitForTimeout(300);

    const scrollY = await page.evaluate(() => window.scrollY);
    const maxScroll = await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.documentElement.clientHeight
    ));

    return {
      success: true,
      direction,
      scroll_y: scrollY,
      max_scroll: maxScroll,
      at_bottom: scrollY + (await page.evaluate(() => window.innerHeight)) >= maxScroll,
      task_id: resolveTaskId(task_id),
    };
  } catch (e) {
    return {
      error: `Scroll failed: ${e.message}`,
      direction,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_back ──

const BACK_SCHEMA = z.object({
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserBackHandler(args) {
  const { task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session || !session.page) {
      return { error: 'No active browser session. Use browser_navigate first.', task_id: resolveTaskId(task_id) };
    }

    const page = session.page;

    // Check if there's history to go back to
    const canGoBack = await page.evaluate(() => window.history.length > 1);
    if (!canGoBack) {
      return {
        success: false,
        error: 'No history to go back to.',
        url: page.url(),
        task_id: resolveTaskId(task_id),
      };
    }

    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(500);

    const title = await page.title();
    const currentUrl = page.url();

    return {
      success: true,
      title: title || '',
      url: currentUrl,
      task_id: resolveTaskId(task_id),
      message: `Went back to ${currentUrl}`,
    };
  } catch (e) {
    return {
      error: `Go back failed: ${e.message}`,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_press ──

const PRESS_SCHEMA = z.object({
  key: z.string().min(1).describe('The key to press (e.g. Enter, Escape, Tab, ArrowDown, ArrowUp, etc.)'),
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserPressHandler(args) {
  const { key, task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session || !session.page) {
      return { error: 'No active browser session. Use browser_navigate first.', task_id: resolveTaskId(task_id) };
    }

    const page = session.page;
    await page.keyboard.press(key);
    await page.waitForTimeout(200);

    return {
      success: true,
      key,
      url: page.url(),
      task_id: resolveTaskId(task_id),
      message: `Pressed key: ${key}`,
    };
  } catch (e) {
    return {
      error: `Key press failed: ${e.message}`,
      key,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_console ──

const CONSOLE_SCHEMA = z.object({
  clear: z.boolean().optional().default(false).describe('If true, clear the captured console logs.'),
  expression: z.string().optional().describe('JavaScript expression to evaluate in the page context. Returns the result.'),
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserConsoleHandler(args) {
  const { clear, expression, task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session || !session.page) {
      return { error: 'No active browser session. Use browser_navigate first.', task_id: resolveTaskId(task_id) };
    }

    const page = session.page;

    // If expression is provided, evaluate it
    if (expression) {
      try {
        const result = await page.evaluate((expr) => {
          try {
            return { success: true, value: eval(expr) };
          } catch (evalErr) {
            return { success: false, error: evalErr.message };
          }
        }, expression);

        return {
          expression,
          result,
          task_id: resolveTaskId(task_id),
        };
      } catch (e) {
        return {
          expression,
          error: `Failed to evaluate expression: ${e.message}`,
          task_id: resolveTaskId(task_id),
        };
      }
    }

    // Return captured console logs
    const logs = session.consoleLogs || [];
    const result = {
      log_count: logs.length,
      logs: logs.slice(-200).map(l => ({
        type: l.type,
        text: l.text,
        timestamp: l.timestamp,
      })),
      task_id: resolveTaskId(task_id),
    };

    if (clear) {
      session.consoleLogs = [];
      result.cleared = true;
    }

    return result;
  } catch (e) {
    return {
      error: `Console operation failed: ${e.message}`,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_get_images ──

const GET_IMAGES_SCHEMA = z.object({
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserGetImagesHandler(args) {
  const { task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session || !session.page) {
      return { error: 'No active browser session. Use browser_navigate first.', task_id: resolveTaskId(task_id) };
    }

    const page = session.page;

    const images = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const seen = new Set();
      return imgs
        .filter(img => {
          const src = img.src || img.getAttribute('src') || '';
          if (!src || seen.has(src)) return false;
          seen.add(src);
          return true;
        })
        .map((img, idx) => ({
          src: img.src || img.getAttribute('src') || '',
          alt: img.alt || '',
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
          index: idx,
        }))
        .filter(img => img.src && !img.src.startsWith('data:'));
    });

    return {
      count: images.length,
      url: page.url(),
      task_id: resolveTaskId(task_id),
      images,
    };
  } catch (e) {
    return {
      error: `Failed to get images: ${e.message}`,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool: browser_vision ──

const VISION_SCHEMA = z.object({
  question: z.string().optional().describe('Optional question about the current page'),
  task_id: z.string().optional().describe('Task ID for managing multiple browser sessions'),
});

async function browserVisionHandler(args) {
  const { question, task_id } = args;
  try {
    const session = await getSession(task_id);
    if (!session || !session.page) {
      return { error: 'No active browser session. Use browser_navigate first.', task_id: resolveTaskId(task_id) };
    }

    const page = session.page;

    // Take a full-page screenshot and return as data URL
    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: false,
    });

    const dataUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;

    return {
      url: page.url(),
      title: await page.title(),
      question: question || null,
      screenshot: dataUrl,
      mime_type: 'image/png',
      size_bytes: screenshotBuffer.length,
      task_id: resolveTaskId(task_id),
    };
  } catch (e) {
    return {
      error: `Screenshot failed: ${e.message}`,
      task_id: resolveTaskId(task_id),
    };
  }
}

// ── Tool Definitions ──

const toolDefinitions = [
  {
    name: 'august__browser_navigate',
    description: 'Navigate to a URL in a headless browser session. Returns page title, URL, and refreshes the accessibility snapshot. Use this first to start a browser session.',
    schema: NAVIGATE_SCHEMA,
    handler: browserNavigateHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{1F310}',
    timeoutMs: 45000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_snapshot',
    description: 'Get an accessibility tree snapshot of the current page. When full=false (default), returns a compact list of interactive elements with ref IDs like @e1, @e2 that can be used with browser_click and browser_type. When full=true, returns the complete accessibility tree with all elements.',
    schema: SNAPSHOT_SCHEMA,
    handler: browserSnapshotHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{1F4F7}',
    timeoutMs: 30000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_click',
    description: 'Click an element on the page by its ref ID from the accessibility snapshot (e.g. @e5). Uses Playwright accessible role locators for robust clicking.',
    schema: CLICK_SCHEMA,
    handler: browserClickHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{1F446}',
    timeoutMs: 15000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_type',
    description: 'Type text into an input field identified by its ref ID from the accessibility snapshot. Uses Playwright accessible role locators for robust targeting.',
    schema: TYPE_SCHEMA,
    handler: browserTypeHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{2328}\uFE0F',
    timeoutMs: 15000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_scroll',
    description: 'Scroll the current page up or down by approximately one viewport height.',
    schema: SCROLL_SCHEMA,
    handler: browserScrollHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{1F4C4}',
    timeoutMs: 10000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_back',
    description: 'Navigate back one step in browser history. Returns the previous page title and URL.',
    schema: BACK_SCHEMA,
    handler: browserBackHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{1F519}',
    timeoutMs: 20000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_press',
    description: 'Press a keyboard key in the browser page. Common keys: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete, Home, End, PageUp, PageDown.',
    schema: PRESS_SCHEMA,
    handler: browserPressHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{2328}',
    timeoutMs: 10000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_console',
    description: 'Get captured console logs from the browser page, or evaluate a JavaScript expression in the page context. Optionally clear the log buffer. Console logs are automatically captured from all page activity.',
    schema: CONSOLE_SCHEMA,
    handler: browserConsoleHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{1F4BB}',
    timeoutMs: 15000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_get_images',
    description: 'Extract all image URLs from the current page. Returns each image with its src URL, alt text, and dimensions.',
    schema: GET_IMAGES_SCHEMA,
    handler: browserGetImagesHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{1F5BC}\uFE0F',
    timeoutMs: 15000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'browser-tools' },
  },
  {
    name: 'august__browser_vision',
    description: 'Take a screenshot of the current page and return it as a base64 data URL. Optionally accepts a question about the page content.',
    schema: VISION_SCHEMA,
    handler: browserVisionHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'browser',
    emoji: '\u{1F441}\uFE0F',
    timeoutMs: 30000,
    requiresEnv: [],
    metadata: { category: 'browser', source: 'hermes-browser' },
  },
];

// ── Handlers map for direct dispatch ──

const handlers = {
  'august__browser_navigate': browserNavigateHandler,
  'august__browser_snapshot': browserSnapshotHandler,
  'august__browser_click': browserClickHandler,
  'august__browser_type': browserTypeHandler,
  'august__browser_scroll': browserScrollHandler,
  'august__browser_back': browserBackHandler,
  'august__browser_press': browserPressHandler,
  'august__browser_console': browserConsoleHandler,
  'august__browser_get_images': browserGetImagesHandler,
  'august__browser_vision': browserVisionHandler,
};

// ── Registration helper ──

function registerBrowserTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(toolDefinitions);
}

// ── Cleanup ──

async function cleanup() {
  const errors = [];
  for (const [tid, session] of sessions.entries()) {
    try {
      if (session.page && session.page.close) {
        await session.page.close().catch(() => {});
      }
    } catch (e) {
      errors.push({ task_id: tid, error: e.message, phase: 'page' });
    }
    try {
      if (session.context && session.context.close) {
        await session.context.close().catch(() => {});
      }
    } catch (e) {
      errors.push({ task_id: tid, error: e.message, phase: 'context' });
    }
    try {
      if (session.browser && session.browser.close) {
        await session.browser.close().catch(() => {});
      }
    } catch (e) {
      errors.push({ task_id: tid, error: e.message, phase: 'browser' });
    }
  }
  sessions.clear();
  return { closed: sessions.size === 0, errors: errors.length > 0 ? errors : undefined };
}

// ── Exports ──

module.exports = {
  toolDefinitions,
  handlers,
  cleanup,
  registerBrowserTools,
  // Expose session management for testing/diagnostics
  getSession,
  getOrCreateSession,
  sessions,
  DEFAULT_TASK_ID,
};
