const http = require('http');

const DEFAULT_HOST = process.env.HOST_AGENT_HOST || 'host.docker.internal';
const DEFAULT_PORT = Number(process.env.HOST_AGENT_PORT || 6312);
const TIMEOUT = Number(process.env.HOST_AGENT_TIMEOUT || 15000);

let cachedStatus = null;
let lastCheck = 0;

function agentUrl(endpoint) {
  const host = process.env.HOST_AGENT_HOST || DEFAULT_HOST;
  const port = Number(process.env.HOST_AGENT_PORT || DEFAULT_PORT);
  return { host, port, path: endpoint };
}

function request(endpoint, body) {
  const { host, port, path } = agentUrl(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host, port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid response from host agent')); }
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Host agent timeout')); });
    req.write(JSON.stringify(body || {}));
    req.end();
  });
}

async function checkHealth() {
  const now = Date.now();
  if (now - lastCheck < 5000 && cachedStatus !== null) return cachedStatus;
  const { host, port } = agentUrl('/health');
  return new Promise(resolve => {
    const req = http.get({ hostname: host, port, path: '/health', timeout: 3000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        cachedStatus = res.statusCode === 200 ? 'connected' : 'error';
        lastCheck = Date.now();
        resolve(cachedStatus);
      });
    });
    req.on('error', () => { cachedStatus = 'disconnected'; lastCheck = Date.now(); resolve('disconnected'); });
    req.on('timeout', () => { req.destroy(); cachedStatus = 'disconnected'; lastCheck = Date.now(); resolve('disconnected'); });
  });
}

function toolDefinitions() {
  return [
    {
      name: 'computer_screenshot',
      description: 'Take a full-desktop screenshot. Returns a base64-encoded PNG. Use this to see what is on the user\'s screen.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'computer_mouse_move',
      description: 'Move the mouse cursor to absolute screen coordinates (x, y).',
      input_schema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Screen X coordinate (0 = left edge)' },
          y: { type: 'number', description: 'Screen Y coordinate (0 = top edge)' }
        },
        required: ['x', 'y']
      }
    },
    {
      name: 'computer_mouse_click',
      description: 'Click a mouse button at the current cursor position, or at specified coordinates.',
      input_schema: {
        type: 'object',
        properties: {
          button: { type: 'string', enum: ['left', 'right'], default: 'left', description: 'Which button to click' },
          x: { type: 'number', description: 'Optional X coordinate to move to before clicking' },
          y: { type: 'number', description: 'Optional Y coordinate to move to before clicking' }
        }
      }
    },
    {
      name: 'computer_mouse_double_click',
      description: 'Double-click at the current cursor position, or at specified coordinates.',
      input_schema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' }
        }
      }
    },
    {
      name: 'computer_mouse_right_click',
      description: 'Right-click at the current cursor position, or at specified coordinates.',
      input_schema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' }
        }
      }
    },
    {
      name: 'computer_mouse_position',
      description: 'Get the current mouse cursor position (x, y).',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'computer_screen_size',
      description: 'Get the primary monitor screen resolution (width x height).',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'computer_type',
      description: 'Type a string of text at the current keyboard focus. Use SendKeys syntax for special keys inside {curly braces}.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' }
        },
        required: ['text']
      }
    },
    {
      name: 'computer_key',
      description: 'Press a keyboard key or key combination.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name: enter, tab, escape, backspace, delete, up/down/left/right, ctrl+c, alt+tab, etc.' }
        },
        required: ['key']
      }
    },
    {
      name: 'computer_list_windows',
      description: 'List all visible windows on the desktop with their titles, process names, and whether they are focused.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'computer_focus_window',
      description: 'Bring a window to the foreground by searching its title.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Window title text to search for (case-insensitive, supports wildcards)' }
        },
        required: ['title']
      }
    },
    {
      name: 'computer_launch',
      description: 'Launch an application or open a file/URL on the host desktop.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to executable, document, or URL to open' }
        },
        required: ['path']
      }
    },
    {
      name: 'computer_open_browser',
      description: 'Open a visible Chromium browser window on the host desktop, navigated to a URL.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to (default: google.com)' }
        }
      }
    },
    {
      name: 'computer_close_browser',
      description: 'Close the visible browser that was opened by computer_open_browser.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'computer_clipboard_get',
      description: 'Read text from the system clipboard.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'computer_clipboard_set',
      description: 'Write text to the system clipboard.',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  ];
}

const endpointMap = {
  computer_screenshot: '/computer/screenshot',
  computer_mouse_move: '/computer/mouse/move',
  computer_mouse_click: '/computer/mouse/click',
  computer_mouse_double_click: '/computer/mouse/double-click',
  computer_mouse_right_click: '/computer/mouse/right-click',
  computer_mouse_position: '/computer/mouse/position',
  computer_screen_size: '/computer/screen-size',
  computer_type: '/computer/type',
  computer_key: '/computer/key',
  computer_list_windows: '/computer/windows',
  computer_focus_window: '/computer/window/focus',
  computer_launch: '/computer/launch',
  computer_open_browser: '/computer/browser/open',
  computer_close_browser: '/computer/browser/close',
  computer_clipboard_get: '/computer/clipboard',
  computer_clipboard_set: '/computer/clipboard/set'
};

function mapArgs(toolName, args) {
  const m = {
    computer_screenshot: {},
    computer_mouse_move: { x: args.x, y: args.y },
    computer_mouse_click: { button: args.button || 'left', x: args.x, y: args.y },
    computer_mouse_double_click: { x: args.x, y: args.y },
    computer_mouse_right_click: { x: args.x, y: args.y },
    computer_mouse_position: {},
    computer_screen_size: {},
    computer_type: { text: args.text },
    computer_key: { key: args.key },
    computer_list_windows: {},
    computer_focus_window: { title: args.title },
    computer_launch: { path: args.path, args: args.args },
    computer_open_browser: { url: args.url },
    computer_close_browser: {},
    computer_clipboard_get: {},
    computer_clipboard_set: { text: args.text }
  };
  return m[toolName] || args;
}

async function execute(toolName, args) {
  const endpoint = endpointMap[toolName];
  if (!endpoint) throw new Error('Unknown host-agent tool: ' + toolName);

  try {
    const result = await request(endpoint, mapArgs(toolName, args));
    return result;
  } catch (e) {
    const status = await checkHealth();
    if (status !== 'connected') {
      return {
        error: true,
        message: 'Host computer agent is not running. Start it on your Windows host: cd host-agent && npm start (listens on port 6312, connectable via host.docker.internal).',
        detail: e.message
      };
    }
    throw e;
  }
}

async function getStatus() {
  const s = await checkHealth();
  return s;
}

module.exports = { toolDefinitions, execute, getStatus, checkHealth };
