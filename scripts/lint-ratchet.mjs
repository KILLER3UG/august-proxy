#!/usr/bin/env node
/* ── lint-ratchet.mjs — warning-count ratchet (audit B3) ─────────────────
 *
 * `eslint . --max-warnings=600` is a ceiling that never lowers: 600 warnings
 * is as acceptable on day one as on day one-hundred. This script compares the
 * CURRENT warning count against frontend/desktop/lint-budget.json and fails
 * when it is WORSE; a PR that lowers the count lowers the budget with it.
 *
 *   node scripts/lint-ratchet.mjs            # enforce
 *   node scripts/lint-ratchet.mjs --update   # write the current count
 *
 * Runs eslint itself (json formatter) — ~1–2 min on the full tree, which is
 * why it is its own script and not part of the per-edit path.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const FE = resolve(REPO, 'frontend', 'desktop');
const BUDGET = join(SCRIPT_DIR, 'lint-budget.json');
const UPDATE = process.argv.includes('--update');

let parsed;
try {
  const raw = execFileSync('npx', ['eslint', '.', '-f', 'json', '--no-warn-ignored'], {
    cwd: FE,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  parsed = JSON.parse(raw);
} catch (err) {
  // eslint exits non-zero on lint ERRORS — its stdout still carries the json.
  try {
    parsed = JSON.parse(String(err.stdout));
  } catch {
    console.error('[lint-ratchet] could not run eslint:', err.message);
    process.exit(2);
  }
}

const warnings = parsed.reduce((sum, f) => sum + (f.warningCount || 0), 0);
const errors = parsed.reduce((sum, f) => sum + (f.errorCount || 0), 0);
const filesWithNewErrors = parsed.filter((f) => f.errorCount > 0).map((f) => f.filePath);

if (errors > 0) {
  console.error(`[lint-ratchet] eslint reports ${errors} error(s) — fix these first:`);
  for (const f of filesWithNewErrors.slice(0, 10)) console.error(`  ${f}`);
  process.exit(1);
}

if (UPDATE) {
  writeFileSync(BUDGET, JSON.stringify({ warnings }, null, 2) + '\n');
  console.log(`[lint-ratchet] budget updated: ${warnings} warnings`);
  process.exit(0);
}

const budget = existsSync(BUDGET) ? JSON.parse(readFileSync(BUDGET, 'utf8')).warnings : warnings;
if (warnings <= budget) {
  console.log(`[lint-ratchet] ok — ${warnings} warnings (budget ${budget})`);
  if (warnings < budget) {
    console.error(
      `[lint-ratchet] note: count is BELOW budget — lower it with --update so the ratchet tightens.`,
    );
  }
  process.exit(0);
}
console.error(
  `[lint-ratchet] FAIL — ${warnings} warnings exceeds the budget of ${budget}.\n` +
    'Fix the new warnings (or justify + re-baseline with --update in the same PR).',
);
process.exit(1);
