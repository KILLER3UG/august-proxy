#!/usr/bin/env node
/**
 * check-brain-config.mjs — the brain-config keys the Settings panel writes
 * must be keys the backend accepts, at values the backend accepts.
 *
 * The panel (`sections/settings/TurnLimitsSection.tsx`) hand-writes a table
 * of brain-config keys with their own min/max. The backend
 * (`services/brain_config_service.py`) owns the truth: which keys exist,
 * which are writable, and what range each one takes. Nothing compared the
 * two, and every way they could disagree was silent:
 *
 *   * a key in the panel's table that the backend does not accept — the
 *     control renders, the PUT 400s, and the user is told "unknown field";
 *   * a key with a `fieldTable` entry but no `numKeys`/`boolKeys` entry —
 *     `allowedKeys` excludes it, so every PUT naming it is rejected. This
 *     happened twice: `journalIntervalHours` (the cadence was unwritable)
 *     and `decisionJournal` (the switch that promotes `record_decision` into
 *     the core tool set could never be moved);
 *   * a panel range wider than the backend's — the control offers a value
 *     the backend refuses. `maxWorkbenchToolLoops` shipped with a backend
 *     range of 1..500 while the panel's own default is 0, so the value the
 *     panel wrote for "turn everything off" was invalid.
 *
 * The gate asks the BACKEND rather than re-implementing it. The probe
 * imports the real service and reports the allowed-key set, the field table,
 * the explicit range branches, and each key's effective range read out of
 * the validator's own error message — so the gate cannot disagree with the
 * validator about what the range is.
 *
 * The four assertions:
 *
 *   1. every key the panel writes is in the backend's `numKeys`;
 *   2. every key the panel writes has a `fieldTable` entry;
 *   3. every key the panel writes has an EXPLICIT range branch (a key on
 *      the fallback inherits a range that starts at 1, which is wrong for a
 *      key where 0 means off);
 *   4. the panel's own [min, max] lies inside the backend's range.
 *
 * Plus one REPORT-ONLY check: a backend `fieldTable` key that the API
 * refuses to write is the same defect the four above catch, in a place the
 * panel does not render. The known instances are listed in
 * `scripts/brain-config-ranges.pending.json`; a NEW one fails, because a
 * silent 400 is a silent 400.
 *
 * Usage: node scripts/check-brain-config.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = resolve(root, 'backend-py/scripts/brain_config_probe.py');
const PANEL = resolve(root, 'frontend/desktop/src/sections/settings/TurnLimitsSection.tsx');
const MANIFEST = resolve(root, 'scripts/brain-config-ranges.pending.json');

/** Find a python that can import the backend app. */
function resolvePython() {
  const candidates = [
    { cmd: resolve(root, 'backend-py/.venv/Scripts/python.exe'), via: 'backend-py/.venv' },
    { cmd: resolve(root, 'backend-py/.venv/bin/python'), via: 'backend-py/.venv' },
    { cmd: 'python3', via: 'python3 on PATH' },
    { cmd: 'python', via: 'python on PATH' },
  ];
  for (const c of candidates) {
    try {
      if (c.cmd.includes('/') || c.cmd.includes('\\')) {
        if (!existsSync(c.cmd)) continue;
      }
      execFileSync(c.cmd, ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore' });
      return c.cmd;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const py = resolvePython();
if (!py) {
  console.error(
    '[check-brain-config] no usable Python found — tried backend-py/.venv and python3/python ' +
      'on PATH. This gate needs an interpreter that can import the backend app.'
  );
  process.exit(2);
}

let backend;
try {
  backend = JSON.parse(execFileSync(py, [PROBE], { encoding: 'utf8', cwd: root, maxBuffer: 8e6 }));
} catch (err) {
  console.error(`[check-brain-config] the probe failed: ${err.message}`);
  process.exit(2);
}

/** The panel's own table: key, min, max. */
function panelFields() {
  const text = readFileSync(PANEL, 'utf8');
  const start = text.indexOf('const TURN_FIELDS');
  if (start === -1) throw new Error('TURN_FIELDS is gone from TurnLimitsSection.tsx');
  const end = text.indexOf('\n];', start);
  const body = text.slice(start, end === -1 ? undefined : end);
  const out = [];
  const re = /key:\s*'([A-Za-z0-9_]+)'[\s\S]*?min:\s*(-?\d+)[\s\S]*?max:\s*(-?\d+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push({ key: m[1], min: Number(m[2]), max: Number(m[3]) });
  }
  if (out.length === 0) throw new Error('no fields parsed out of TURN_FIELDS');
  return out;
}

const fields = panelFields();
const errors = [];
const notes = [];

// 1. The key exists as a numeric key in the backend.
for (const f of fields) {
  if (!backend.numKeys.includes(f.key)) {
    errors.push(
      `the panel writes '${f.key}' but the backend's numKeys does not contain it — ` +
        'the control renders and the PUT is rejected as an unknown field.'
    );
  }
}

// 2. The key has a fieldTable entry, so the backend can describe it.
for (const f of fields) {
  if (!backend.fieldKeys.includes(f.key)) {
    errors.push(
      `the panel writes '${f.key}' but the backend's fieldTable has no entry for it — ` +
        'the key is not described, defaulted, or surfaced by the config API.'
    );
  }
}

// 3. The key has an EXPLICIT range branch.
for (const f of fields) {
  if (!backend.explicitRangeKeys.includes(f.key)) {
    errors.push(
      `the panel writes '${f.key}' but the validator gives it no explicit range branch — ` +
        'it inherits the fallback range, which starts at 1, so the panel cannot write 0.'
    );
  }
}

// 4. The panel's range lies inside the backend's range.
for (const f of fields) {
  const range = backend.ranges[f.key];
  if (!range || range.length !== 2) {
    errors.push(`the backend reports no range for '${f.key}' — the panel cannot be checked.`);
    continue;
  }
  const [lo, hi] = range;
  if (f.min < lo || f.max > hi) {
    errors.push(
      `the panel offers ${f.key} in [${f.min}, ${f.max}] but the backend accepts ` +
        `[${lo}, ${hi}] — the control offers values the backend refuses.`
    );
  }
  if (f.min < lo || f.min > hi) {
    errors.push(
      `the panel's minimum for ${f.key} is ${f.min}, which the backend rejects ` +
        `(accepted: ${lo}..${hi}).`
    );
  }
}

// REPORT-ONLY: a backend fieldTable key the API refuses to write.
const notWritable = backend.fieldKeys.filter((k) => !backend.allowedKeys.includes(k));
let known = [];
if (existsSync(MANIFEST)) {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    known = manifest.notWritable ?? [];
  } catch (err) {
    console.error(`[check-brain-config] ${MANIFEST} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}
const fresh = notWritable.filter((k) => !known.includes(k));
for (const k of fresh) {
  errors.push(
    `the backend's fieldTable lists '${k}' but the API refuses to write it (it is not in ` +
      'numKeys/boolKeys/floatKeys/strKeys, so validatePatch rejects it as an unknown ' +
      'field). Either the key is missing from the writable set, or the fieldTable entry ' +
      'is dead. Record it in scripts/brain-config-ranges.pending.json if it is deliberate.'
  );
}
if (notWritable.length) {
  notes.push(
    `${notWritable.length} fieldTable key(s) are not writable and are recorded as known: ` +
      notWritable.join(', ')
  );
}

// The manifest and the code must agree: a key that IS writable must not stay
// listed, or the list rots into a permanent excuse.
for (const k of known) {
  if (!notWritable.includes(k)) {
    errors.push(
      `scripts/brain-config-ranges.pending.json lists '${k}' as not writable, but it is ` +
        'writable now — remove the entry so the list stays an exception list, not a ' +
        'rubbish bin.'
    );
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`FAIL  ${e}`);
  console.error(
    `\n${errors.length} brain-config problem(s). A key the panel writes has to be a key the ` +
      'backend accepts, at a value the backend accepts.'
  );
  process.exit(1);
}

for (const n of notes) console.log(`OK   ${n}`);
console.log(
  `\nAll ${fields.length} panel field(s) are backend keys with a fieldTable entry, an ` +
    'explicit range branch, and a range the backend accepts.',
);
