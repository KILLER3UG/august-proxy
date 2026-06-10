/**
 * hermes-execute.js — Execute Python code with access to proxy tool stubs.
 *
 * Tool: august__execute_code
 *
 * Provides a safe, sandboxed Python subprocess that can use proxy tools
 * (read_file, write_file, search_files, patch, terminal, etc.) via a
 * generated `proxy_tools` module using pure-Python implementations.
 *
 * Based on the Hermes code_execution_tool.py pattern.
 *
 * Timeout:  max 300 seconds
 * Stdout:   capped at 50 KB
 * Temp dir: auto-cleaned after each execution
 */

const { z } = require('zod');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateProxyToolsPy } = require('./proxy-tools-stubs');

// ── Constants ──

const MAX_TIMEOUT_MS = 300_000;   // 5 min
const MAX_STDOUT_BYTES = 50_000;   // 50 KB
const MIN_TIMEOUT_MS = 2_000;

// Python command to use (platform-aware).
// Context says: python3=missing, python=3.11.15 available.
const PYTHON_CMD = process.platform === 'win32'
  ? (fs.existsSync('C:\\Python311\\python.exe') ? 'C:\\Python311\\python.exe' : 'python')
  : (fs.existsSync('/usr/bin/python3') ? 'python3' : 'python');

// ── Schema ──

const executeCodeSchema = z.object({
  code: z.string().min(1, 'code is required').max(100_000, 'code too large (max 100KB)'),
  timeout: z.number().int().min(1).max(300).optional().default(300),
  cwd: z.string().optional()
});

// ── Temp file helpers ──

let _tempCounter = 0;

function createTempDir() {
  const dir = path.join(os.tmpdir(), `august_exec_${Date.now()}_${++_tempCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // Best-effort cleanup
  }
}

// ── Handler ──

/**
 * Execute a Python code snippet in a sandboxed subprocess.
 *
 * @param {object} args  { code, timeout?, cwd? }
 * @param {object} ctx   Tool context (unused but available for future auth/permissions)
 * @returns {Promise<{stdout: string, stderr: string, exit_code: number, timed_out: boolean}>}
 */
async function executeCodeHandler(args, ctx = {}) {
  const { code, timeout, cwd } = executeCodeSchema.parse(args);
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(timeout * 1000, MAX_TIMEOUT_MS));

  const tempDir = createTempDir();
  let scriptPath = null;

  try {
    // 1. Generate proxy_tools.py stub module in the temp dir
    generateProxyToolsPy(tempDir);

    // 2. Write the user's code to a temp script
    const scriptName = `__exec_${Date.now().toString(36)}.py`;
    scriptPath = path.join(tempDir, scriptName);

    // Wrap the code to capture uncaught top-level exceptions
    const wrappedCode = [
      '# -*- coding: utf-8 -*-',
      '"""August Proxy execute_code — auto-wrapped"""',
      'import sys, traceback',
      'try:',
      ...code.split('\n').map(line => '  ' + line),
      'except Exception:',
      '  traceback.print_exc()',
      '  sys.exit(1)',
      ''
    ].join('\n');

    fs.writeFileSync(scriptPath, wrappedCode, 'utf-8');

    // 3. Spawn Python subprocess
    const procCwd = cwd ? path.resolve(cwd) : tempDir;

    const result = await new Promise((resolve) => {
      const child = spawn(PYTHON_CMD, [scriptName], {
        cwd: procCwd,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUNBUFFERED: '1',
          AUGUST_PROXY_ROOT: path.resolve(__dirname, '..', '..', '..'),
          AUGUST_TEMP_DIR: tempDir
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
      }, timeoutMs);

      const onDone = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Cap stdout
        if (stdout.length > MAX_STDOUT_BYTES) {
          stdout = stdout.slice(0, MAX_STDOUT_BYTES) +
            `\\n[... stdout truncated at ${(MAX_STDOUT_BYTES / 1024).toFixed(0)} KB]\\n`;
        }
        resolve({
          stdout,
          stderr,
          exit_code: timedOut ? -1 : (child.exitCode ?? 0),
          timed_out: timedOut
        });
      };

      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', err => {
        if (!settled) {
          stderr += `\\n[Error spawning Python: ${err.message}]\\n`;
          onDone();
        }
      });
      child.on('exit', () => onDone());
    });

    return result;
  } finally {
    // 4. Cleanup — best-effort
    cleanTempDir(tempDir);
  }
}

// ── Tool Definition ──

const executeToolDefinitions = [
  {
    name: 'august__execute_code',
    description: `Run a Python script that can call proxy tools programmatically.
The script runs in a sandboxed subprocess with up to 5-minute timeout and 50KB stdout cap.
Available imports:
  from proxy_tools import read_file, write_file, search_files, list_files, patch, terminal

- read_file(path) — read file contents
- write_file(path, content) — write file (creates parent dirs)
- search_files(pattern[, root, file_glob, max_results]) — regex search inside files
- list_files(pattern[, root]) — glob file listing
- patch(path, old_string, new_string[, replace_all]) — find-replace in a file
- terminal(command[, timeout, cwd]) — execute a shell command

The script is automatically wrapped in a try/except that prints tracebacks.`,
    schema: z.object({
      code: z.string().min(1, 'Python code is required').max(100_000, 'Code too large'),
      timeout: z.number().int().min(1).max(300).optional().default(300),
      cwd: z.string().optional().describe('Working directory for the subprocess')
    }),
    handler: executeCodeHandler,
    toolset: 'execute',
    permissions: { category: 'sandbox', destructive: true },
    emoji: '🐍',
    timeoutMs: MAX_TIMEOUT_MS + 10_000,
    metadata: { source: 'execute-tools', python: PYTHON_CMD }
  }
];

module.exports = {
  executeCodeHandler,
  executeSchema: executeCodeSchema,
  executeToolDefinitions
};

/**
 * Register execute tools with a tool registry.
 * @param {object} registry - Tool registry with registerMany() method
 */
function registerExecuteTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(executeToolDefinitions);
}

module.exports = {
  executeCodeHandler,
  executeSchema: executeCodeSchema,
  executeToolDefinitions,
  registerExecuteTools
};
