// scripts/dev-app.mjs
//
// Starts the backend API and Vite frontend together for local development.
//
// Usage:
//   npm run dev

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const commands = [
    {
        name: 'backend',
        command: npm,
        args: ['run', 'start'],
        env: { AUGUST_PROXY_PORT: process.env.AUGUST_PROXY_PORT || '8085' }
    },
    { name: 'frontend', command: npm, args: ['run', 'dev:web'] }
];

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
