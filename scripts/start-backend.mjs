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

function findPython() {
    const names = process.platform === 'win32'
        ? ['python.exe', 'python3.exe', 'py.exe']
        : ['python3', 'python'];
    for (const name of names) {
        try {
            execFileSync(name, ['--version'], { stdio: 'ignore' });
            return name;
        } catch { /* try next */ }
    }
    // Windows fallback: check common installation paths
    if (process.platform === 'win32') {
        const commonPaths = [
            'C:\\Users\\rober\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
            'C:\\Users\\rober\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
            'C:\\Python313\\python.exe',
            'C:\\Python312\\python.exe',
            `${process.env.LOCALAPPDATA || ''}\\Programs\\Python\\Python313\\python.exe`,
            `${process.env.LOCALAPPDATA || ''}\\Programs\\Python\\Python312\\python.exe`,
        ];
        for (const p of commonPaths) {
            if (existsSync(p)) return p;
        }
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
            '--port', port, '--host', '127.0.0.1'
        ], {
            cwd: backendDir,
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
