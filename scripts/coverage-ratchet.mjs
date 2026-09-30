#!/usr/bin/env node
/* ── coverage-ratchet.mjs — per-module floors for the harness core (roadmap #11)
 *
 * `--cov-fail-under=55` is a global floor, currently sitting at ~70%. That
 * number is carried by modules that are not the harness: 5,000 statements of
 * well-tested plumbing dilute the average, so it can improve while the modules
 * the guarantees actually live in rot.
 *
 * The measured holes at the time this was written:
 *
 *   loop/recovery.py         62%   the self-correction machinery
 *   loop/exec.py             63%   tool dispatch and the interception seams
 *   managed_tool_policy.py   56%   the profile filter BOTH wire paths and the
 *                                    executor depend on
 *   providers.py 1010-1278     0%   a 269-line block with no test at all
 *   mcp_client.py            28%   606 of 837 statements uncovered
 *   web_backends.py          17%   the fetch path
 *
 * So: one budget file, one floor per module, enforced independently of the
 * global number. A module that loses coverage fails here even when the total
 * is up.
 *
 * Deliberately NOT folded into lint-ratchet.mjs despite the roadmap saying to:
 * that script runs eslint over frontend/desktop and compares a warning count.
 * Reusing it for Python coverage would mean teaching it two languages, two
 * tools and two output formats, and a ratchet that runs eslint is not one you
 * can run when you only need to check coverage. Same conventions, same
 * --update escape hatch, separate script.
 *
 *   node scripts/coverage-ratchet.mjs            # enforce
 *   node scripts/coverage-ratchet.mjs --update   # write the current floors
 *
 * Reads backend-py/coverage.json (pytest-cov --cov-report=json). If that file
 * is absent the ratchet REFUSES to pass: a guard that silently skips when it
 * cannot measure is a guard that is always green.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const BUDGET = join(SCRIPT_DIR, 'coverage-budget.json');
const COVERAGE = join(REPO, 'backend-py', 'coverage.json');
const UPDATE = process.argv.includes('--update');

/**
 * Harness-core modules and the floor each must never fall below. Chosen by
 * what the module GUARDS, not by how easy it is to cover: these are the files
 * whose defects stop the harness from doing its job.
 *
 * Floors are deliberately below the current measurement. This ratchet is here
 * to stop a regression, not to demand new tests on the day it lands — a floor
 * set AT the current number fails the moment a good PR removes an unreachable
 * branch. Raise them as real tests land.
 */
const FLOORS = {
  'app/services/workbench/loop/recovery.py': 55,
  'app/services/workbench/loop/exec.py': 55,
  'app/services/workbench/loop/events.py': 70,
  'app/services/workbench/loop/guards.py': 65,
  'app/services/workbench/managed_tool_policy.py': 50,
  'app/services/turn_outcomes.py': 70,
  'app/services/tool_policy.py': 85,
  'app/services/memory_store/consolidation.py': 55,
  'app/services/project_memory.py': 70,
  'app/services/workbench/tool_guardrails.py': 85,
};

if (!existsSync(COVERAGE)) {
  console.error(
    `[coverage-ratchet] cannot measure: ${COVERAGE} does not exist.\n` +
      'Run the suite with coverage first:\n' +
      '  cd backend-py && uv run pytest -q -n auto --cov-report=json\n' +
      'A ratchet that passes when it cannot see is a ratchet that is always green.',
  );
  process.exit(2);
}

const report = JSON.parse(readFileSync(COVERAGE, 'utf8'));
const measured = {};
for (const [file, data] of Object.entries(report.files || {})) {
  // Keys are already relative to backend-py ("app\\services\\..."). Normalise
  // the separators and use the summary coverage.py already computed — the
  // first version of this script re-derived the percentage from branch counts
  // that the JSON summary does not carry, and reported 0% for every module.
  const rel = file.replace(/\\/g, '/');
  const pct = data.summary && data.summary.percent_covered;
  if (typeof pct === 'number' && Number.isFinite(pct)) measured[rel] = pct;
}

const rows = [];
const failed = [];

for (const [file, floor] of Object.entries(FLOORS)) {
  const pct = measured[file];
  if (pct === undefined) {
    rows.push({ file, pct: null, floor, status: 'MISSING' });
    failed.push({ file, why: 'not present in coverage.json — was it renamed or deleted?' });
    continue;
  }
  const ok = pct >= floor;
  rows.push({ file, pct, floor, status: ok ? 'ok' : 'FAIL' });
  if (!ok) failed.push({ file, why: `${pct.toFixed(1)}% is below the ${floor}% floor` });
}

if (UPDATE) {
  const next = Object.fromEntries(rows.filter((r) => r.pct !== null).map((r) => [r.file, Number(r.pct.toFixed(1))]));
  writeFileSync(BUDGET, JSON.stringify({ floors: next }, null, 2) + '\n');
  console.log(`[coverage-ratchet] floors updated for ${Object.keys(next).length} module(s).`);
  process.exit(0);
}

for (const r of rows.sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1))) {
  const pct = r.pct === null ? '  --  ' : `${r.pct.toFixed(1).padStart(5)}%`;
  const mark = r.status === 'ok' ? 'OK  ' : 'FAIL';
  console.log(`[coverage-ratchet] ${mark} ${pct}  (floor ${r.floor}%)  ${r.file}`);
}

// A file listed in the budget but absent from the floors is stale config.
if (existsSync(BUDGET)) {
  const budget = JSON.parse(readFileSync(BUDGET, 'utf8')).floors || {};
  for (const file of Object.keys(budget)) {
    if (!(file in FLOORS)) {
      failed.push({ file, why: 'present in coverage-budget.json but no longer in FLOORS' });
    }
  }
}

const total = rows.reduce((s, r) => s + (r.pct ?? 0), 0) / (rows.length || 1);
console.log(`[coverage-ratchet] harness-core mean: ${total.toFixed(1)}% across ${rows.length} module(s)`);

if (failed.length) {
  for (const f of failed) console.error(`[coverage-ratchet] FAIL ${f.file} — ${f.why}`);
  console.error(
    `\n${failed.length} harness-core module(s) below floor. The global coverage number ` +
      'can stay flat or rise while these rot, which is the whole reason this gate exists. ' +
      'Add tests, or justify + re-baseline with --update in the same PR.',
  );
  process.exit(1);
}
console.log('[coverage-ratchet] ok — every harness-core module is at or above its floor.');
