// scripts/dev-tauri.mjs
//
// Starts the Vite dev server, waits for it to be ready, then launches
// `tauri dev` which loads the frontend from the Vite server and spawns
// the Tauri native shell.
//
// Usage:
//   npm run dev:desktop

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const VITE_PORT = 5173;

let exiting = false;
let viteChild = null;
let tauriChild = null;

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
    if (!child || !child.pid || child.killed) return;

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

    stopChild(tauriChild);
    stopChild(viteChild);
    setTimeout(() => process.exit(code), 1000).unref?.();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Poll until a TCP port is accepting connections. */
function waitForPort(port, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
            const socket = net.createConnection({ port, host: '127.0.0.1' });
            socket.on('connect', () => {
                socket.destroy();
                clearInterval(interval);
                resolve();
            });
            socket.on('error', () => {
                socket.destroy();
                if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    reject(new Error(`Port ${port} not ready within ${timeoutMs}ms`));
                }
            });
        }, 500);
    });
}

// ── 1. Start Vite dev server ──────────────────────────────────────────────

console.log('[dev] starting Vite dev server…');

viteChild = spawn(npm, ['run', 'dev:web'], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
});

viteChild.stdout.on('data', chunk => writePrefixed(process.stdout, 'vite', chunk));
viteChild.stderr.on('data', chunk => writePrefixed(process.stderr, 'vite', chunk));

viteChild.on('error', error => {
    console.error(`${prefix('vite')}failed to start: ${error.message}`);
    shutdown(1);
});

viteChild.on('exit', (code, signal) => {
    console.log(`${prefix('vite')}exited with ${signal || code}`);
    if (!exiting) shutdown(code ?? 1);
});

// ── 2. Wait for Vite to be ready, then launch Tauri ───────────────────────

try {
    await waitForPort(VITE_PORT);
    console.log(`[dev] Vite ready on :${VITE_PORT}`);
} catch (err) {
    console.error(`[dev] ${err.message}`);
    shutdown(1);
}

console.log('[dev] launching tauri dev…');

tauriChild = spawn(npm, ['run', 'tauri:dev'], {
    cwd: resolve(root, 'frontend/desktop'),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
});

tauriChild.stdout.on('data', chunk => writePrefixed(process.stdout, 'tauri', chunk));
tauriChild.stderr.on('data', chunk => writePrefixed(process.stderr, 'tauri', chunk));

tauriChild.on('error', error => {
    console.error(`${prefix('tauri')}failed to start: ${error.message}`);
    shutdown(1);
});

tauriChild.on('exit', (code, signal) => {
    console.log(`${prefix('tauri')}exited with ${signal || code}`);
    if (!exiting) shutdown(code ?? 1);
});

console.log('[dev] backend:  http://127.0.0.1:8085');
console.log(`[dev] frontend: http://localhost:${VITE_PORT}`);
console.log('[dev] tauri:    native shell (loading from Vite)');
console.log('[dev] press Ctrl+C to stop all');
