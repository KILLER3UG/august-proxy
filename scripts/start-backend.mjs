// scripts/start-backend.mjs
//
// Starts the backend API server. Tries Python (uvicorn) first, falls back to
// Node.js (backend/index.js). Called by `npm run start`.
//
// Usage:
//   npm run start
//   AUGUST_PROXY_PORT=8086 npm run start

import { spawn, execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.AUGUST_PROXY_PORT || '8085';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function isStoreStub(p) {
    return p.replace(/\\/g, '/').toLowerCase().includes('windowsapps');
}

function findPython() {
    // 1. Prefer the project's own .venv (created by install.ps1 / install.sh).
    const venvRel = process.platform === 'win32'
        ? 'backend-py/.venv/Scripts/python.exe'
        : 'backend-py/.venv/bin/python';
    const venvPath = resolve(root, venvRel);
    if (existsSync(venvPath)) return venvPath;

    // 2. On Windows, prefer the `py` launcher (avoids the Microsoft Store stub).
    const candidates = [];
    if (process.platform === 'win32') candidates.push('py');
    candidates.push('python3', 'python');
    for (const name of candidates) {
        try {
            // `py` needs the `-3` flag to select Python 3; probe it explicitly.
            const probeArgs = name === 'py' ? ['-3', '--version'] : ['--version'];
            execFileSync(name, probeArgs, { stdio: 'ignore' });
            // Resolve the absolute path so we can reject the Store stub.
            const resolved = execFileSync(name, name === 'py' ? ['-3', '-c', 'import sys; print(sys.executable)'] : ['-c', 'import sys; print(sys.executable)'], { stdio: ['ignore', 'pipe', 'ignore'] })
                .toString()
                .trim();
            if (resolved && !isStoreStub(resolved)) return resolved;
        } catch { /* try next */ }
    }
    return null;
}

async function start() {
    const python = findPython();
    const backendDir = resolve(root, 'backend-py');

    if (python && existsSync(backendDir)) {
        console.log(`[start] Starting Python backend on :${port}`);
        const child = spawn(python, [
            '-m', 'uvicorn', 'app.main:app',
            '--port', port, '--host', '127.0.0.1',
            '--app-dir', backendDir,
        ], {
            cwd: root,
            env: { ...process.env, AUGUST_PROXY_PORT: port },
            stdio: 'inherit',
        });
        child.on('exit', (code) => process.exit(code ?? 1));
    } else {
        console.log(`[start] Starting Node.js backend on :${port}`);
        const child = spawn(npm, ['run', 'start:node'], {
            cwd: root,
            env: { ...process.env, AUGUST_PROXY_PORT: port },
            stdio: 'inherit',
        });
        child.on('exit', (code) => process.exit(code ?? 1));
    }
}

start().catch(console.error);
