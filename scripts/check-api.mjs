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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const PY = resolve(REPO, 'backend-py', '.venv', 'Scripts', 'python.exe');
const EXPORT = resolve(REPO, 'backend-py', 'scripts', 'export_openapi.py');
const SCHEMA = resolve(REPO, 'docs', 'api', 'openapi.json');

if (!existsSync(PY)) {
  console.error('[check-api] backend venv not found — run from a prepared checkout');
  process.exit(2);
}

let stdout;
try {
  stdout = execFileSync(PY, [EXPORT, '--check'], { encoding: 'utf8', cwd: REPO });
} catch (err) {
  // export_openapi --check prints the failure and exits 1 on drift.
  console.error(String(err.stdout || err.message).trim());
  process.exit(1);
}
console.log(stdout.trim());
