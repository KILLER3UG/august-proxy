#!/usr/bin/env node
/**
 * check-docs-sync.mjs — Verify numeric claims in the docs match the code.
 *
 * Each assertion names the doc file it reads, so a claim in AGENTS.md and one in
 * docs/API_REFERENCE.md are guarded the same way.
 *
 * AGENTS.md is a STANDING INSTRUCTION FILE: every agent session reads it and
 * plans against the limits it states. It asserted `MAX_MANAGED_TOOL_ROUNDS`
 * "defaults to 25" for months after the default became 0, so models sized
 * their work against a cap that did not exist (audit finding 2026-09-15 #6).
 * This is the same idea as check-version-sync.mjs, applied to numbers.
 *
 * Usage: node scripts/check-docs-sync.mjs
 * Exit 0: every claim matches its code constant.
 * Exit 1: a mismatch, OR a claim/constant that can no longer be located — a
 *         renamed constant must fail the check, never pass it silently.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
      file: 'backend-py/app/services/workbench/workbench.py',
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
];

let failed = 0;
const results = [];

for (const check of assertions) {
  let docText = '';
  let codeText = '';
  try {
    docText = readFileSync(resolve(root, check.doc.file), 'utf8');
  } catch {
    results.push({ ok: false, label: check.label, detail: `cannot read ${check.doc.file}` });
    failed += 1;
    continue;
  }
  try {
    codeText = readFileSync(resolve(root, check.code.file), 'utf8');
  } catch {
    results.push({ ok: false, label: check.label, detail: `cannot read ${check.code.file}` });
    failed += 1;
    continue;
  }
  const docMatch = docText.match(check.doc.re);
  const codeMatch = codeText.match(check.code.re);
  if (!docMatch) {
    results.push({
      ok: false,
      label: check.label,
      detail: `${check.doc.file} no longer states this claim — re-add it or delete the assertion`,
    });
    failed += 1;
    continue;
  }
  if (!codeMatch) {
    results.push({
      ok: false,
      label: check.label,
      detail: `constant not found in ${check.code.file} — the code moved or renamed it`,
    });
    failed += 1;
    continue;
  }
  const docValue = docMatch[1];
  const codeValue = codeMatch[1];
  if (docValue === codeValue) {
    results.push({ ok: true, label: check.label, detail: `${codeValue}` });
  } else {
    results.push({
      ok: false,
      label: check.label,
      detail: `${check.doc.file} says ${docValue}, code says ${codeValue}`,
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
