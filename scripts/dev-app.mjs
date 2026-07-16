// scripts/dev-app.mjs
//
// Starts the backend API and Vite frontend together for local development.
// Tries Python backend first, falls back to Node.js.
//
// Usage:
//   npm run dev

import { spawn, execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const port = process.env.AUGUST_PROXY_PORT || '8085';

// ── Detect Python (preferred) or fall back to Node.js ──────────────

// Returns the {major, minor} of an interpreter, or null if it can't run.
function pythonVersionAt(interp) {
    try {
        const out = execFileSync(
            interp,
            ['-c', 'import sys;print(sys.version_info[0], sys.version_info[1])'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
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

// The project requires Python 3.12+ (see backend-py/pyproject.toml).
const MIN_PY = { major: 3, minor: 12 };

function isAcceptedVersion(interp) {
    const v = pythonVersionAt(interp);
    if (!v) return false;
    return v.major > MIN_PY.major ||
        (v.major === MIN_PY.major && v.minor >= MIN_PY.minor);
}

// Reject interpreters that can't load sqlite3 (common on Windows when Smart App
// Control / Application Control blocks uv-managed CPython's _sqlite3.pyd).
function canImportSqlite(interp) {
    try {
        execFileSync(interp, ['-c', 'import sqlite3'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return true;
    } catch {
        return false;
    }
}

function isUsablePython(interp) {
    if (!isAcceptedVersion(interp)) return false;
    if (!canImportSqlite(interp)) {
        console.warn(`[dev] Skipping Python (sqlite3 blocked / unloadable): ${interp}`);
        return false;
    }
    return true;
}

function findPython() {
    // 1. Prefer the project's own virtualenv (has the exact backend deps).
    const venvRel = process.platform === 'win32'
        ? ['backend-py', '.venv', 'Scripts', 'python.exe']
        : ['backend-py', '.venv', 'bin', 'python'];
    const venvPath = resolve(root, ...venvRel);
    if (existsSync(venvPath) && isUsablePython(venvPath)) {
        return venvPath;
    }

    // 2. uv: respects backend-py/.python-version and managed interpreters.
    const backendDir = resolve(root, 'backend-py');
    if (existsSync(backendDir)) {
        try {
            const uvPy = execFileSync(
                'uv',
                ['run', '--directory', backendDir, 'python', '-c', 'import sys; print(sys.executable)'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
            ).toString().trim();
            if (uvPy && existsSync(uvPy) && isUsablePython(uvPy)) {
                return uvPy;
            }
        } catch { /* uv not installed or not ready */ }
    }

    // 3. PATH / py launcher — only accept 3.12+ with a working sqlite3.
    const names = process.platform === 'win32'
        ? ['py.exe', 'python3.exe', 'python.exe']
        : ['python3', 'python'];
    for (const name of names) {
        if (isUsablePython(name)) return name;
    }
    return null;
}

let python = findPython();

let commands;
if (python) {
    const backendDir = resolve(root, 'backend-py');
    if (existsSync(backendDir)) {
        commands = [
            {
                name: 'backend',
                command: python,
                args: ['-m', 'uvicorn', 'app.main:app', '--port', port, '--host', '127.0.0.1', '--app-dir', backendDir],
                cwd: root,
                env: { AUGUST_PROXY_PORT: port }
            },
            { name: 'frontend', command: npm, args: ['run', 'dev:web'] }
        ];
        console.log(`[dev] Using Python backend on :${port}`);
    } else {
        console.log('[dev] backend-py/ not found, falling back to Node.js');
        python = null;
    }
}

if (!python) {
    commands = [
        {
            name: 'backend',
            command: npm,
            args: ['run', 'start'],
            env: { AUGUST_PROXY_PORT: port }
        },
        { name: 'frontend', command: npm, args: ['run', 'dev:web'] }
    ];
    console.log(`[dev] Using Node.js backend on :${port}`);
}

const children = [];
let exiting = false;

function prefix(name) {
    return `[${name.padEnd(8)}] `;
}

function writePrefixed(stream, name, chunk) {
    const text = chunk.toString();
    const lines = text.split(/\r?\n/);
    const formatted = lines
        .map((line, index) => index === 0 ? prefix(name) + line : (line ? prefix(name) + line : ''))
        .join('\n');

    stream.write(formatted + (text.endsWith('\n') ? '' : '\n'));
}

function stopChild(child) {
    if (!child.pid || child.killed) return;

    if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        return;
    }

    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        child.kill('SIGTERM');
    }
}

function shutdown(code = 0) {
    if (exiting) return;
    exiting = true;

    for (const child of children) stopChild(child);
    setTimeout(() => process.exit(code), 1000).unref?.();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const { name, command, args, env = {} } of commands) {
    const child = spawn(command, args, {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32' && command.endsWith('.cmd')
    });

    children.push(child);

    child.stdout.on('data', chunk => writePrefixed(process.stdout, name, chunk));
    child.stderr.on('data', chunk => writePrefixed(process.stderr, name, chunk));

    child.on('error', error => {
        console.error(`${prefix(name)}failed to start: ${error.message}`);
        shutdown(1);
    });

    child.on('exit', (code, signal) => {
        console.log(`${prefix(name)}exited with ${signal || code}`);
        if (!exiting) shutdown(code ?? 1);
    });
}

console.log('[dev] backend:  http://127.0.0.1:8085');
console.log('[dev] frontend: http://localhost:5173');
console.log('[dev] press Ctrl+C to stop both');
