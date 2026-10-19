#!/usr/bin/env node
/**
 * check-docs-sync.mjs — Verify the claims in the docs match the code.
 *
 * Each assertion names the doc file it reads, so a claim in AGENTS.md and one in
 * docs/API_REFERENCE.md are guarded the same way.
 *
 * AGENTS.md is a STANDING INSTRUCTION FILE: every agent session reads it and
 * plans against the limits it states. It asserted `MAX_MANAGED_TOOL_ROUNDS`
 * "defaults to 25" for months after the default became 0, so models sized
 * their work against a cap that did not exist (audit finding 2026-09-15 #6).
 * It then said there were "25 inline Rust `#[cfg(test)]` blocks" when there
 * were 5, and that the brain-config validator's fallback range "starts at 1"
 * when it started at 0 — a range that rejected the value the Settings panel
 * writes for "turn everything off". This is the same idea as
 * check-version-sync.mjs, applied to numbers and to claims.
 *
 * FOUR WAYS TO ASSERT, because a claim is not always a number:
 *
 *   equal   (default)  the doc's captured value(s) must equal the code's
 *                      captured value(s), group by group.
 *   contains           both the doc and the code must contain the thing, and
 *                      the doc's captured text must appear in the code.
 *   each               the doc names a list (several matches of its regex);
 *                      every named item must appear in the code.
 *   count              the doc states a number; the code pattern is COUNTED
 *                      and the counts must agree.
 *
 * Usage: node scripts/check-docs-sync.mjs
 * Exit 0: every claim matches its code.
 * Exit 1: a mismatch, OR a claim/constant that can no longer be located — a
 *         renamed constant must fail the check, never pass it silently.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOC = 'AGENTS.md';

/**
 * Each assertion pairs a capture in the doc with a capture in the code and
 * requires the two strings to be equal. Keep the list short and load-bearing:
 * every entry is a number an agent is told to plan against.
 */
const assertions = [
  {
    label: 'tool-round cap default',
    doc: { file: DOC, re: /`MAX_MANAGED_TOOL_ROUNDS`\s+defaults to\s+\*\*(\d+)/ },
    code: {
      file: 'backend-py/app/services/workbench/workbench.py',
      re: /^MAX_MANAGED_TOOL_ROUNDS\s*=\s*(\d+)/m,
    },
  },
  {
    label: 'stall nudge threshold',
    doc: { file: DOC, re: /never advances across\s+(\d+)\+\s+stalled rounds/ },
    code: {
      file: 'backend-py/app/services/workbench/loop/guards.py',
      re: /^MIN_ROUNDS_BEFORE_STALL_CHECK\s*=\s*(\d+)/m,
    },
  },
  {
    label: 'brain backup retention',
    doc: {
      file: 'docs/API_REFERENCE.md',
      re: /only the newest \*\*(\d+)\*\* copies survive/,
    },
    code: {
      file: 'backend-py/app/services/brain_backup.py',
      re: /^KEEP_BACKUPS: Final = (\d+)/m,
    },
  },
  {
    label: 'brain startup backup interval',
    doc: {
      file: 'docs/API_REFERENCE.md',
      re: /takes one verified copy per (\d+) h at startup/,
    },
    code: {
      file: 'backend-py/app/services/brain_backup.py',
      // `max_age_hours: float = 12.0` — the doc states whole hours.
      re: /max_age_hours: float = (\d+)(?:\.0+)?/,
    },
  },
  // The two file-read ceilings are the numbers an agent plans against when it
  // decides whether a large log is readable at all, and the paged ceiling
  // exists because the normal one is deliberately skipped for paged reads
  // (audit 2026-09-27 #12). Both are stated in MB; both are `N * 1024 * 1024`.
  {
    label: 'read_file size ceiling',
    doc: { file: DOC, re: /`_MAXFileSize`\s+\(\*\*(\d+) MB\*\*\)/ },
    code: {
      file: 'backend-py/app/services/tool_registrations/file_tools.py',
      re: /^_MAXFileSize = (\d+) \* 1024 \* 1024$/m,
    },
  },
  {
    label: 'read_file paged size ceiling',
    doc: { file: DOC, re: /`_MAXPageFileSize`\s+\(\*\*(\d+) MB\*\*\)/ },
    code: {
      file: 'backend-py/app/services/tool_registrations/file_tools.py',
      re: /^_MAXPageFileSize = (\d+) \* 1024 \* 1024$/m,
    },
  },

  // ── The round after the review ──────────────────────────────────────
  // These five are claims an agent ACTS on, and each of them was wrong at
  // some point in this repository's history.

  // It said 25 inline Rust `#[cfg(test)]` blocks. There are 5. The count
  // was copied forward from before the test suite was deleted, and it
  // drifted twice before anyone checked it against the tree.
  {
    label: 'inline Rust test-block count',
    mode: 'count',
    doc: { file: DOC, re: /the (\d+) inline Rust/ },
    code: {
      dir: 'frontend/desktop/src-tauri',
      ext: '.rs',
      re: /#\[cfg\(test\)\]/g,
    },
  },
  // The version-source list is the gate's, and the doc states how many there
  // are so an agent knows what "all the sources" means. `check:version`
  // proves the nine AGREE; nothing proved the doc still said nine.
  {
    label: 'version source count',
    mode: 'count',
    doc: { file: DOC, re: /All (\d+) sources must match/ },
    code: {
      file: 'scripts/check-version-sync.mjs',
      re: /^ {4}label: '/gm,
    },
  },
  // The brain-config validator's fallback range. The doc said it "starts at
  // 1" for years after it started at 0, and a key on the fallback could
  // never be written with 0 — which is what "0 means off" means.
  {
    label: 'brain-config fallback range',
    doc: { file: DOC, re: /maxWorkbenchLoopsRange`?\s*\((\d+)[–-](\d+)\)/ },
    code: {
      file: 'backend-py/app/services/brain_config_service.py',
      re: /^maxWorkbenchLoopsRange = \((\d+), (\d+)\)/m,
    },
  },
  // The updater's launch flags. The doc names them, the code passes them,
  // and a change to one without the other is a silent behaviour change: a
  // `/S` that stops being passed puts the install wizard back.
  {
    label: 'updater launch flags',
    mode: 'contains',
    doc: { file: DOC, re: /launched with `(\/UPDATE \/S)`/ },
    code: {
      file: 'frontend/desktop/src-tauri/src/backend.rs',
      re: /\.arg\("\/UPDATE"\)[\s\S]{0,200}?\.arg\("\/S"\)/,
    },
  },
  // Every `recovery` kind the doc names must be a kind the backend emits.
  // The frame is the trust signal — `degraded: true` is how a rescue says
  // "this answer may be incomplete" — so a kind that is renamed, or one
  // that is documented and never emitted, is a doc and the app disagreeing
  // about what a user was told.
  {
    label: 'recovery kinds the doc names',
    mode: 'each',
    doc: { file: DOC, re: /recovery\s*\{kind:\s*'([a-z-]+)'/g },
    code: { file: 'backend-py/app/services/workbench/workbench.py' },
  },
];

/** Every file under a directory with a given extension. */
function filesIn(dir, ext) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'target' || entry === 'node_modules') continue;
        walk(full);
      } else if (entry.endsWith(ext)) {
        out.push(full);
      }
    }
  };
  walk(resolve(root, dir));
  return out;
}

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

/**
 * `matchAll` requires a global regex, and an assertion's regex is written
 * without the `g` flag because it is usually matched once. Clone it with the
 * flag rather than making every assertion author remember it — a regex that
 * has to carry `g` to be matched at all is a trap.
 */
function globalRe(re) {
  if (re.global) return re;
  const flags = re.flags.replace(/y/g, '') + 'g';
  return new RegExp(re.source, flags);
}

let failed = 0;
const results = [];

for (const check of assertions) {
  const mode = check.mode ?? 'equal';

  // ── The doc side ──
  let docText;
  try {
    docText = read(check.doc.file);
  } catch {
    results.push({ ok: false, label: check.label, detail: `cannot read ${check.doc.file}` });
    failed += 1;
    continue;
  }
  const docMatches = [...docText.matchAll(globalRe(check.doc.re))];
  if (docMatches.length === 0) {
    results.push({
      ok: false,
      label: check.label,
      detail: `${check.doc.file} no longer states this claim — re-add it or delete the assertion`,
    });
    failed += 1;
    continue;
  }

  // ── The code side ──
  let codeText = '';
  if (check.code.file) {
    try {
      codeText = read(check.code.file);
    } catch {
      results.push({
        ok: false,
        label: check.label,
        detail: `cannot read ${check.code.file}`,
      });
      failed += 1;
      continue;
    }
  } else if (check.code.dir) {
    const files = filesIn(check.code.dir, check.code.ext ?? '.rs');
    codeText = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  }

  if (mode === 'count') {
    const codeCount = [...codeText.matchAll(check.code.re)].length;
    const docValue = docMatches[0][1];
    if (String(codeCount) === docValue) {
      results.push({ ok: true, label: check.label, detail: `${docValue}` });
    } else {
      results.push({
        ok: false,
        label: check.label,
        detail: `${check.doc.file} says ${docValue}, the code has ${codeCount}`,
      });
      failed += 1;
    }
    continue;
  }

  if (mode === 'contains') {
    const codeMatch = codeText.match(check.code.re);
    const docValue = docMatches[0][1];
    if (codeMatch && docValue && codeText.includes(docValue)) {
      results.push({ ok: true, label: check.label, detail: docValue });
    } else {
      results.push({
        ok: false,
        label: check.label,
        detail: codeMatch
          ? `${check.doc.file} says ${docValue}, which the code does not contain`
          : `${check.code.file ?? check.code.dir} no longer has this shape — the code moved`,
      });
      failed += 1;
    }
    continue;
  }

  if (mode === 'each') {
    const named = docMatches.map((m) => m[1]);
    const missing = named.filter((name) => !codeText.includes(`'${name}'`));
    if (missing.length === 0) {
      results.push({
        ok: true,
        label: check.label,
        detail: named.join(', '),
      });
    } else {
      results.push({
        ok: false,
        label: check.label,
        detail: `the code never emits: ${missing.join(', ')}`,
      });
      failed += 1;
    }
    continue;
  }

  // mode === 'equal'
  const codeMatch = codeText.match(check.code.re);
  if (!codeMatch) {
    results.push({
      ok: false,
      label: check.label,
      detail: `constant not found in ${check.code.file} — the code moved or renamed it`,
    });
    failed += 1;
    continue;
  }
  const docValues = docMatches[0].slice(1).filter((v) => v !== undefined);
  const codeValues = codeMatch.slice(1).filter((v) => v !== undefined);
  if (docValues.length === codeValues.length && docValues.every((v, i) => v === codeValues[i])) {
    results.push({ ok: true, label: check.label, detail: codeValues.join(', ') });
  } else {
    results.push({
      ok: false,
      label: check.label,
      detail: `${check.doc.file} says ${docValues.join(', ')}, code says ${codeValues.join(', ')}`,
    });
    failed += 1;
  }
}

for (const result of results) {
  console.log(`${result.ok ? 'OK  ' : 'FAIL'}  ${result.label}: ${result.detail}`);
}

if (failed > 0) {
  console.error(
    `\n${failed} documentation claim(s) disagree with the code. ` +
      'Fix the doc file named in the FAIL line above to match the code (the code ' +
      'is the truth), then re-run: node scripts/check-docs-sync.mjs'
  );
  process.exit(1);
}
console.log(`\nAll ${assertions.length} doc claim(s) match the code.`);
