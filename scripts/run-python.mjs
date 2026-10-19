#!/usr/bin/env node
/**
 * run-python.mjs — run a backend script with an interpreter that can import
 * the backend app.
 *
 * The backend's scripts live in `backend-py/scripts/` and are written to be
 * run from the backend's own directory, with the app importable. Which
 * interpreter can do that differs by machine: a checkout usually has
 * `backend-py/.venv`, CI has a `setup-python` interpreter, and a developer
 * may have neither.
 *
 * `scripts/check-api.mjs` already solved this for the OpenAPI gate; this is
 * the same resolution in one reusable place, so an npm script can say
 * `node scripts/run-python.mjs e2e_smoke.py` and mean the same thing on
 * every machine.
 *
 *   node scripts/run-python.mjs e2e_smoke.py [args...]
 *
 * Exit 2 means no usable interpreter was found — which is a broken
 * environment, not a failing check, and is kept distinct from the script's
 * own exit code for that reason.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = process.argv[2];
const rest = process.argv.slice(3);

if (!script) {
  console.error('usage: node scripts/run-python.mjs <script.py> [args...]');
  process.exit(2);
}

const candidates = [
  { cmd: resolve(root, 'backend-py/.venv/Scripts/python.exe'), via: 'backend-py/.venv' },
  { cmd: resolve(root, 'backend-py/.venv/bin/python'), via: 'backend-py/.venv' },
  { cmd: 'python3', via: 'python3 on PATH' },
  { cmd: 'python', via: 'python on PATH' },
];

let chosen = null;
for (const c of candidates) {
  try {
    if (c.cmd.includes('/') || c.cmd.includes('\\')) {
      if (!existsSync(c.cmd)) continue;
    }
    execFileSync(c.cmd, ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore' });
    chosen = c;
    break;
  } catch {
    /* try the next one */
  }
}

if (!chosen) {
  console.error(
    '[run-python] no usable Python found — tried backend-py/.venv and python3/python on PATH. ' +
      'This needs an interpreter that can import the backend app.',
  );
  process.exit(2);
}

const target = resolve(root, 'backend-py/scripts', script);
if (!existsSync(target)) {
  console.error(`[run-python] no such backend script: ${target}`);
  process.exit(2);
}

try {
  execFileSync(chosen.cmd, [target, ...rest], {
    stdio: 'inherit',
    cwd: resolve(root, 'backend-py'),
  });
} catch (err) {
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
