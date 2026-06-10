const { exec } = require('child_process');

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\b>:?\s*\/dev\b/i,
  /\b:\(\s*\)\s*\{/i,
  /\bchmod\s+-?777\b/i,
  /\bchown\b/i,
  /\bmv\s+\/[^ ]+/i,
];

const MANAGED_BASH_TOOLS = new Set([
  'bash',
  'mcp__workspace__bash'
]);

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_CHARS = 10000;

function isDangerous(command) {
  return DANGEROUS_PATTERNS.some(p => p.test(command));
}

function isManagedBashToolName(name) {
  return MANAGED_BASH_TOOLS.has(name);
}

function normalizeBashToolName(toolName) {
  if (toolName === 'mcp__workspace__bash') return 'bash';
  return toolName;
}

function getManagedBashToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'mcp__workspace__bash',
        description: 'Execute a bash command in the proxy workspace container. Returns stdout, stderr, and exit code. Use for file operations, code analysis, git commands, and scripts.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute.' },
            timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000).' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Execute a bash command in the proxy workspace container. Returns stdout, stderr, and exit code.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute.' },
            timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000).' }
          },
          required: ['command']
        }
      }
    }
  ];
}

async function executeManagedBashTool(toolName, args, workspacePath = null, onProgress = null, parentSignal = null) {
  const localName = normalizeBashToolName(toolName);
  if (localName !== 'bash') {
    throw new Error(`Unknown bash tool: ${toolName}`);
  }

  const command = String(args.command || args.command_line || args.script || '').trim();
  if (!command) {
    return { stdout: '', stderr: 'No command provided.', exitCode: 1 };
  }

  if (isDangerous(command)) {
    return {
      stdout: '',
      stderr: `Command rejected: pattern matches a blocked security pattern.`,
      exitCode: 1
    };
  }

  const timeoutMs = Math.min(
    Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS,
    120000
  );

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => {
      if (resolved) return;
      resolved = true;
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onAbort);
      }
      resolve(val);
    };

    const onAbort = () => {
      try {
        child.kill('SIGINT');
      } catch (e) {}
      safeResolve({ stdout: '', stderr: 'Command aborted by user.', exitCode: 130 });
    };

    if (parentSignal && parentSignal.aborted) {
      safeResolve({ stdout: '', stderr: 'Command aborted by user.', exitCode: 130 });
      return;
    }

    const child = exec(command, {
      cwd: workspacePath || '/app',
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_CHARS * 2,
      shell: '/bin/bash'
    }, (error, stdout, stderr) => {
      const result = {
        stdout: (stdout || '').slice(0, MAX_OUTPUT_CHARS),
        stderr: (stderr || '').slice(0, MAX_OUTPUT_CHARS),
        exitCode: error ? (error.code || error.killed ? 137 : 1) : 0
      };
      if (stdout && stdout.length > MAX_OUTPUT_CHARS) {
        result.stdout += '\n... (output truncated)';
      }
      if (stderr && stderr.length > MAX_OUTPUT_CHARS) {
        result.stderr += '\n... (output truncated)';
      }
      safeResolve(result);
    });

    if (parentSignal) {
      parentSignal.addEventListener('abort', onAbort);
    }

    if (onProgress) {
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          onProgress(data.toString());
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          onProgress(data.toString());
        });
      }
    }
  });
}

module.exports = {
  isManagedBashToolName,
  executeManagedBashTool,
  getManagedBashToolDefinitions
};
