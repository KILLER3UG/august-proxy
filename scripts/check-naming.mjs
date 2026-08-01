#!/usr/bin/env node
/* ── check-naming.mjs — naming-convention guardrail ───────────────────────
 *
 * The backend mixes snake_case and camelCase parameter names (legacy debt —
 * see docs/GAPS_AND_BUGS.md "Dual naming"). A bulk rename was attempted and
 * reverted after ~125 test failures, so this check does NOT demand a rename:
 * it only fails when NEW camelCase parameters appear in service function
 * signatures, compared against the checked-in baseline (naming-baseline.json).
 *
 * Scope: Python function signatures under backend-py/app/services/ (params
 * only). Function names, call sites, routers, and the rest of the tree are
 * out of scope. Run with `--update` to regenerate the baseline (only after
 * an intentional rename that removed entries).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const SERVICES = resolve(REPO, 'backend-py', 'app', 'services');
const BASELINE = join(SCRIPT_DIR, 'naming-baseline.json');
const UPDATE = process.argv.includes('--update');

/** Collect "relative/path.py:paramName" entries for camelCase params in
 *  service function signatures. Naive paren-balancing across lines; defaults
 *  with commas inside string literals are the only known blind spot. */
function collect() {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === '__pycache__' || name === 'build') continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.py')) scanFile(full, entries);
    }
  };
  walk(SERVICES);
  return entries.sort();
}

function scanFile(file, out) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rel = relative(REPO, file).replace(/\\/g, '/');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*def\s+\w+\s*\(/.test(lines[i])) continue;
    let buf = lines[i];
    let j = i;
    let depth = 0;
    for (const ch of buf) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    while (depth > 0 && j + 1 < lines.length) {
      j++;
      buf += lines[j];
      for (const ch of lines[j]) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
    }
    const start = buf.indexOf('(');
    const end = buf.lastIndexOf(')');
    if (start === -1 || end <= start) continue;
    for (const raw of buf.slice(start + 1, end).split(',')) {
      let param = raw.trim();
      if (!param) continue;
      if (param.startsWith('*')) param = param.slice(1).trim();
      if (param.startsWith('**')) param = param.slice(2).trim();
      // Strip annotation / default: keep the name up to `:` or `=`.
      param = param.split(/[:=]/, 1)[0].trim();
      if (!param || param === 'self' || param === 'cls') continue;
      if (/[A-Z]/.test(param)) out.push(`${rel}:${param}`);
    }
  }
}

const current = new Set(collect());
const baseline = existsSync(BASELINE)
  ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8')))
  : new Set();

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify([...current].sort(), null, 2) + '\n');
  console.log(`[check-naming] baseline updated: ${current.size} camelCase params across services`);
  process.exit(0);
}

const fresh = [...current].filter((e) => !baseline.has(e));
if (fresh.length === 0) {
  console.log(`[check-naming] ok — ${current.size} known camelCase params (no new ones)`);
  process.exit(0);
}
console.error(`[check-naming] FAIL — ${fresh.length} NEW camelCase param(s) in service signatures:`);
for (const e of fresh) console.error(`  ${e}`);
console.error(
  'Use snake_case for new parameters (see docs/GAPS_AND_BUGS.md "Dual naming").\n' +
    'If the rename is intentional, run: node scripts/check-naming.mjs --update',
);
process.exit(1);
