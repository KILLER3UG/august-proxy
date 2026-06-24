/**
 * cua-backend.js — CUA (Computer Use Agent) backend implementation.
 * Inspired by Hermes's cua_backend.py pattern.
 *
 * Uses MCP over stdio to communicate with cua-driver.
 * Supports macOS (SkyLight), Windows (Win32), and Linux (X11).
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { ComputerUseBackend, Point, Rectangle, UIElement, CaptureResult, ActionResult, AppInfo, HealthStatus } = require('./backend');

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

// ── CUA Backend ──

class CuaBackend extends ComputerUseBackend {
  constructor() {
    super();
    this._process = null;
    this._sessionId = `august-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._config = {};
    this._lastCapture = null;
  }

  /**
   * Initialize the CUA backend.
   */
  async initialize(config = {}) {
    this._config = { ...getConfig(), ...config };

    // Find cua-driver binary
    const binaryPath = this._findBinary();
    if (!binaryPath) {
      throw new Error('cua-driver binary not found. Install from https://github.com/august-proxy/cua-driver');
    }

    // Start cua-driver process
    await this._startDriver(binaryPath);
    this._initialized = true;
    console.log(`[CuaBackend] Initialized with session: ${this._sessionId}`);
  }

  /**
   * Find the cua-driver binary.
   */
  _findBinary() {
    // Check config first
    if (this._config.binary_path) {
      try {
        const { execSync } = require('child_process');
        execSync(`"${this._config.binary_path}" --version`, { stdio: 'ignore' });
        return this._config.binary_path;
      } catch {}
    }

    // Check PATH
    try {
      const { execSync } = require('child_process');
      const cmd = process.platform === 'win32' ? 'where cua-driver' : 'which cua-driver';
      return execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
    } catch {}

    // Check common locations
    const commonPaths = process.platform === 'win32'
      ? [
          path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cua-driver', 'cua-driver.exe'),
          path.join(os.homedir(), '.august', 'bin', 'cua-driver.exe')
        ]
      : [
          path.join(os.homedir(), '.august', 'bin', 'cua-driver'),
          '/usr/local/bin/cua-driver',
          '/opt/homebrew/bin/cua-driver'
        ];

    for (const p of commonPaths) {
      try {
        const { execSync } = require('child_process');
        execSync(`"${p}" --version`, { stdio: 'ignore' });
        return p;
      } catch {}
    }

    return null;
  }

  /**
   * Start the cua-driver process.
   */
  async _startDriver(binaryPath) {
    return new Promise((resolve, reject) => {
      const args = [
        '--session', this._sessionId,
        '--format', 'json'
      ];

      this._process = spawn(binaryPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CUADRIVER_SESSION: this._sessionId
        }
      });

      let initialized = false;

      this._process.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'ready' && !initialized) {
              initialized = true;
              resolve();
            }
          } catch {}
        }
      });

      this._process.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('error') || msg.includes('Error')) {
          console.error('[CuaBackend] stderr:', msg);
        }
      });

      this._process.on('error', reject);
      this._process.on('exit', (code) => {
        if (!initialized) {
          reject(new Error(`cua-driver exited with code ${code}`));
        }
      });

      // Timeout
      setTimeout(() => {
        if (!initialized) {
          reject(new Error('cua-driver initialization timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Send a command to cua-driver and wait for response.
   */
  async _sendCommand(command, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._process || !this._process.stdin.writable) {
        reject(new Error('cua-driver not running'));
        return;
      }

      const msg = {
        id: Date.now(),
        type: command,
        ...params
      };

      let responseBuffer = '';
      const timeout = setTimeout(() => {
        reject(new Error(`Command ${command} timed out`));
      }, 30000);

      const onData = (data) => {
        responseBuffer += data.toString();
        const lines = responseBuffer.split('\n');
        responseBuffer = lines.pop(); // Keep incomplete line

        for (const line of lines) {
          try {
            const response = JSON.parse(line);
            if (response.id === msg.id) {
              clearTimeout(timeout);
              this._process.stdout.removeListener('data', onData);
              if (response.error) {
                reject(new Error(response.error));
              } else {
                resolve(response);
              }
              return;
            }
          } catch {}
        }
      };

      this._process.stdout.on('data', onData);
      this._process.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  /**
   * Capture the current screen state.
   */
  async capture() {
    const response = await this._sendCommand('capture', {
      include_som: true
    });

    const elements = (response.elements || []).map((el, i) =>
      new UIElement({
        index: i,
        label: el.label || '',
        role: el.role || '',
        bounds: new Rectangle(el.x || 0, el.y || 0, el.width || 0, el.height || 0),
        interactive: el.interactive !== false,
        value: el.value || null,
        description: el.description || ''
      })
    );

    this._lastCapture = new CaptureResult({
      screenshot: response.screenshot,
      elements,
      width: response.width || 0,
      height: response.height || 0,
      somOverlay: response.som_overlay
    });

    return this._lastCapture;
  }

  /**
   * Click on a UI element by index.
   */
  async click(elementIndex) {
    if (!this._lastCapture) {
      await this.capture();
    }

    const element = this._lastCapture.elements[elementIndex];
    if (!element) {
      return new ActionResult({
        success: false,
        message: `Element at index ${elementIndex} not found`
      });
    }

    const center = element.bounds.center();
    const response = await this._sendCommand('click', {
      x: center.x,
      y: center.y,
      button: 'left'
    });

    // Capture after click to get updated state
    const newCapture = await this.capture();

    return new ActionResult({
      success: response.success !== false,
      message: response.message || `Clicked element ${elementIndex}`,
      elements: newCapture.elements,
      screenshot: newCapture.screenshot
    });
  }

  /**
   * Drag from one point to another.
   */
  async drag(from, to) {
    const response = await this._sendCommand('drag', {
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y
    });

    const newCapture = await this.capture();

    return new ActionResult({
      success: response.success !== false,
      message: response.message || 'Drag completed',
      elements: newCapture.elements,
      screenshot: newCapture.screenshot
    });
  }

  /**
   * Scroll the screen.
   */
  async scroll(direction, amount) {
    const response = await this._sendCommand('scroll', {
      direction,
      amount: amount || 100
    });

    const newCapture = await this.capture();

    return new ActionResult({
      success: response.success !== false,
      message: response.message || `Scrolled ${direction}`,
      elements: newCapture.elements,
      screenshot: newCapture.screenshot
    });
  }

  /**
   * Type text at the current cursor position.
   */
  async typeText(text) {
    const response = await this._sendCommand('type', {
      text
    });

    return new ActionResult({
      success: response.success !== false,
      message: response.message || `Typed ${text.length} characters`
    });
  }

  /**
   * Press a key or key combination.
   */
  async key(keyCombo) {
    const response = await this._sendCommand('key', {
      key: keyCombo
    });

    return new ActionResult({
      success: response.success !== false,
      message: response.message || `Pressed ${keyCombo}`
    });
  }

  /**
   * List running applications.
   */
  async listApps() {
    const response = await this._sendCommand('list_apps');

    return (response.apps || []).map(app =>
      new AppInfo({
        id: app.id || '',
        name: app.name || '',
        pid: app.pid || 0,
        focused: app.focused || false,
        bounds: app.bounds ? new Rectangle(app.bounds.x, app.bounds.y, app.bounds.width, app.bounds.height) : null
      })
    );
  }

  /**
   * Focus a specific application.
   */
  async focusApp(appId) {
    const response = await this._sendCommand('focus_app', {
      app_id: appId
    });

    return new ActionResult({
      success: response.success !== false,
      message: response.message || `Focused app ${appId}`
    });
  }

  /**
   * Get backend health status.
   */
  async healthCheck() {
    try {
      const response = await this._sendCommand('health');
      return new HealthStatus({
        healthy: true,
        platform: process.platform,
        backend: 'cua',
        message: 'cua-driver is running',
        details: response
      });
    } catch (error) {
      return new HealthStatus({
        healthy: false,
        platform: process.platform,
        backend: 'cua',
        message: error.message,
        details: { error: error.message }
      });
    }
  }

  /**
   * Clean shutdown of the backend.
   */
  async shutdown() {
    if (this._process) {
      try {
        await this._sendCommand('shutdown');
      } catch {}

      this._process.kill();
      this._process = null;
    }

    this._initialized = false;
    console.log('[CuaBackend] Shut down');
  }
}

module.exports = CuaBackend;
