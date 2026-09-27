#!/usr/bin/env node
/* ── check-api.mjs — OpenAPI drift gate (audit P1#7) ─────────────────────
 *
 * The committed docs/api/openapi.json must match what the app actually
 * serves. This regenerates the schema in a throwaway data dir and compares —
 * a router change without a schema refresh fails here, exactly like
 * check-docs-sync fails on a stale claim.
 *
 * Optional companion step once FE codegen is adopted: `npm run gen:api`
 * (openapi-typescript) reads the same committed file, so one drift gate
 * covers both sides.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const EXPORT = resolve(REPO, 'backend-py', 'scripts', 'export_openapi.py');

/**
 * Find an interpreter that can import the app.
 *
 * This used to hardcode `backend-py/.venv/Scripts/python.exe`, which is a
 * Windows layout AND assumes a venv exists. The CI backend job installs with
 * `pip install -e ".[dev]"` into the system interpreter on ubuntu and never
 * creates a venv, so the gate exited 2 ("venv not found") on every run —
 * a gate that can never pass is worse than no gate, because the failure looks
 * like drift and the real reason is buried in an exit code.
 *
 * Order: explicit override, then a local venv in either layout, then PATH.
 * export_openapi.py puts backend-py on sys.path itself, so all this needs is
 * an interpreter whose site-packages carry the backend's dependencies.
 */
function resolvePython() {
  const override = process.env.AUGUST_PYTHON;
  if (override) {
    if (!existsSync(override)) {
      console.error(`[check-api] AUGUST_PYTHON points at a missing file: ${override}`);
      process.exit(2);
    }
    return { cmd: override, via: 'AUGUST_PYTHON' };
  }

  const venvs = [
    resolve(REPO, 'backend-py', '.venv', 'bin', 'python'), // POSIX venv
    resolve(REPO, 'backend-py', '.venv', 'Scripts', 'python.exe'), // Windows venv
  ];
  for (const venv of venvs) {
    if (existsSync(venv)) return { cmd: venv, via: 'local venv' };
  }

  for (const name of ['python3', 'python']) {
    try {
      execFileSync(name, ['-c', 'pass'], { stdio: 'ignore' });
      return { cmd: name, via: 'PATH' };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const py = resolvePython();
if (!py) {
  console.error(
    '[check-api] no usable Python found — tried AUGUST_PYTHON, ' +
      'backend-py/.venv/{bin/python,Scripts/python.exe}, and python3/python on PATH. ' +
      'This gate needs an interpreter that can import the backend app.'
  );
  process.exit(2);
}

// `--write` regenerates the committed schema instead of checking it. It shares
// the interpreter resolution above on purpose: a generator and a gate that pick
// different interpreters is the exact bug this file already had once.
const WRITE = process.argv.includes('--write');
const ARGS = WRITE ? [] : ['--check'];

let stdout;
try {
  stdout = execFileSync(py.cmd, [EXPORT, ...ARGS], { encoding: 'utf8', cwd: REPO });
} catch (err) {
  // A missing interpreter is NOT drift. Exit 2 keeps the two apart, so a broken
  // environment is never mistaken for a stale schema (or the reverse).
  if (err.code === 'ENOENT') {
    console.error(`[check-api] could not run the interpreter (${py.via}): ${py.cmd}`);
    process.exit(2);
  }
  // export_openapi --check prints the failure and exits 1 on drift.
  console.error(String(err.stdout || err.message).trim());
  process.exit(1);
}
console.log(`[check-api] python via ${py.via}`);
console.log(stdout.trim());
