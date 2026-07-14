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

// Project policy: Python 3.12+ only (see backend-py/pyproject.toml requires-python).
const MIN_PY = { major: 3, minor: 12 };

function isStoreStub(p) {
    return p.replace(/\\/g, '/').toLowerCase().includes('windowsapps');
}

function pythonVersionAt(interp, extraArgs = []) {
    try {
        const out = execFileSync(
            interp,
            [...extraArgs, '-c', 'import sys;print(sys.version_info[0], sys.version_info[1])'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const [majorStr, minorStr] = out.trim().split(/\s+/);
        const major = Number(majorStr);
        const minor = Number(minorStr);
        if (Number.isNaN(major) || Number.isNaN(minor)) return null;
        return { major, minor };
    } catch {
        return null;
    }
}

function isAcceptedVersion(interp, extraArgs = []) {
    const v = pythonVersionAt(interp, extraArgs);
    if (!v) return false;
    return v.major > MIN_PY.major ||
        (v.major === MIN_PY.major && v.minor >= MIN_PY.minor);
}

function resolveExecutable(interp, extraArgs = []) {
    try {
        const resolved = execFileSync(
            interp,
            [...extraArgs, '-c', 'import sys; print(sys.executable)'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).toString().trim();
        if (resolved && !isStoreStub(resolved)) return resolved;
    } catch { /* ignore */ }
    return null;
}

/**
 * Prefer project venv, then uv-managed 3.12, then py -3.12 / PATH —
 * always rejecting interpreters older than 3.12.
 * @returns {{ cmd: string, argsPrefix: string[] } | null}
 */
function findPython() {
    // 1. Project virtualenv (install.ps1 / install.sh / uv sync).
    const venvRel = process.platform === 'win32'
        ? 'backend-py/.venv/Scripts/python.exe'
        : 'backend-py/.venv/bin/python';
    const venvPath = resolve(root, venvRel);
    if (existsSync(venvPath) && isAcceptedVersion(venvPath)) {
        return { cmd: venvPath, argsPrefix: [] };
    }

    // 2. uv: respects backend-py/.python-version and [tool.uv] python-preference.
    const backendDir = resolve(root, 'backend-py');
    if (existsSync(backendDir)) {
        try {
            const uvPy = execFileSync(
                'uv',
                ['run', '--directory', backendDir, 'python', '-c', 'import sys; print(sys.executable)'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
            ).toString().trim();
            if (uvPy && existsSync(uvPy) && isAcceptedVersion(uvPy)) {
                return { cmd: uvPy, argsPrefix: [] };
            }
        } catch { /* uv not installed or not ready */ }
    }

    // 3. Windows py launcher — pin 3.12+ explicitly (never bare `python` first).
    if (process.platform === 'win32') {
        for (const ver of ['-3.14', '-3.13', '-3.12', '-3']) {
            if (isAcceptedVersion('py', [ver])) {
                const resolved = resolveExecutable('py', [ver]);
                if (resolved) return { cmd: resolved, argsPrefix: [] };
            }
        }
    }

    // 4. PATH lookup last — only accept 3.12+.
    const names = process.platform === 'win32'
        ? ['python3.exe', 'python.exe']
        : ['python3', 'python'];
    for (const name of names) {
        if (isAcceptedVersion(name) && !isStoreStub(resolveExecutable(name) || name)) {
            const resolved = resolveExecutable(name);
            if (resolved) return { cmd: resolved, argsPrefix: [] };
        }
    }
    return null;
}

async function start() {
    const python = findPython();
    const backendDir = resolve(root, 'backend-py');

    if (python && existsSync(backendDir)) {
        console.log(`[start] Starting Python backend on :${port} (${python.cmd})`);
        const child = spawn(python.cmd, [
            ...python.argsPrefix,
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
        console.log(`[start] No Python >= 3.12 found; starting Node.js backend on :${port}`);
        console.log('[start] Tip: cd backend-py && uv sync --group dev  (uses .python-version 3.12)');
        const child = spawn(npm, ['run', 'start:node'], {
            cwd: root,
            env: { ...process.env, AUGUST_PROXY_PORT: port },
            stdio: 'inherit',
        });
        child.on('exit', (code) => process.exit(code ?? 1));
    }
}

start().catch(console.error);
