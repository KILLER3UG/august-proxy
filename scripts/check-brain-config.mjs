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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = resolve(root, 'backend-py/scripts/brain_config_probe.py');
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
      // The check is that the interpreter can IMPORT THE BACKEND APP, not
      // merely that it exists. A bare CI python3 passes `import sys` and
      // then dies inside the probe at `import app.config` (pydantic_settings
      // missing) — a cryptic failure that says nothing about the environment.
      execFileSync(c.cmd, ['-c', 'import app.main'], {
        stdio: 'ignore',
        cwd: resolve(root, 'backend-py'),
      });
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

/**
 * Every brain-config key the SETTINGS PANELS write.
 *
 * The gate used to read ONE panel (TurnLimitsSection's TURN_FIELDS table),
 * and every other panel was outside its coverage: MemorySection writes five
 * bool keys, ComputerAccessSettings writes `cameraAccess`, and the Decisions
 * panel writes `decisionJournal` and `journalIntervalHours`. A panel key the
 * backend does not accept would have been caught by nothing — the control
 * would render and the PUT would 400.
 *
 * The scan finds a mutation whose `mutationFn` calls `saveBrainConfig` and
 * then reads the keys off that mutation's call sites. That is a little
 * dataflow, but it is the honest way to tell a brain-config write from the
 * security-policy writes in the same files (`allowedRoots`, `filesystemScope`,
 * `app`, `policy`) — a blanket "any `.mutate({`" scan would report those as
 * brain-config keys and fail on keys that are not brain config at all.
 */
function panelKeys() {
  const dir = resolve(root, 'frontend/desktop/src/sections/settings');
  const out = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.tsx')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    // A brain-config mutation is one whose mutationFn writes the brain
    // config — either through the `saveBrainConfig` helper or by putting
    // to `/api/brain/config` directly (MemorySection does the latter).
    const mutNames = new Set();
    for (const m of text.matchAll(
      /const\s+([A-Za-z0-9_]+)\s*=\s*useMutation\(\{[\s\S]{0,800}?(?:saveBrainConfig|['"`]\/api\/brain\/config['"`])/g,
    )) {
      mutNames.add(m[1]);
    }
    const callSites = [];
    for (const m of text.matchAll(/saveBrainConfig\s*\(/g)) callSites.push(m.index + m[0].length);
    for (const name of mutNames) {
      const re = new RegExp(`${name}\\.mutate\\s*\\(`, 'g');
      for (const m of text.matchAll(re)) callSites.push(m.index + m[0].length);
    }
    for (const at of callSites) {
      for (const key of objectKeys(text, at)) {
        if (!out.has(key)) out.set(key, []);
        if (!out.get(key).includes(file)) out.get(key).push(file);
      }
    }
  }
  return out;
}

/**
 * The keys of the object literal that starts at `from`.
 *
 * EVERY top-level key, not just the first: a mutation that writes two
 * brain-config keys in one call is two keys, and reading only the first
 * would leave the second unchecked. The nesting is tracked so a nested
 * object's keys are not mistaken for the outer ones.
 */
function objectKeys(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return [];
  const start = i;
  let depth = 0;
  let end = -1;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = text.slice(start + 1, end);
  const keys = [];
  let d = 0;
  let chunkStart = 0;
  const chunks = [];
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === '{' || c === '[' || c === '(') d++;
    else if (c === '}' || c === ']' || c === ')') d--;
    else if (c === ',' && d === 0) {
      chunks.push(body.slice(chunkStart, j));
      chunkStart = j + 1;
    }
  }
  chunks.push(body.slice(chunkStart));
  for (const chunk of chunks) {
    const m = chunk.match(/^\s*(?:'([A-Za-z0-9_]+)'|([A-Za-z0-9_]+))\s*:/);
    if (m) keys.push(m[1] ?? m[2]);
  }
  return keys;
}

/** The (min, max) a panel declares for a numeric input, per file. */
function panelRanges() {
  const dir = resolve(root, 'frontend/desktop/src/sections/settings');
  const out = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.tsx')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const ranges = [];
    const re = /min=\{(-?\d+)\}[\s\S]{0,200}?max=\{(-?\d+)\}/g;
    let m;
    while ((m = re.exec(text)) !== null) ranges.push([Number(m[1]), Number(m[2])]);
    if (ranges.length) out.set(file, ranges);
  }
  return out;
}

/* The per-panel table check that used to sit here (checks 1-4, driven by
   TurnLimitsSection's TURN_FIELDS) left with the panel. Checks 5-7 below are
   strictly more general: they scan EVERY settings file for a brain-config
   mutation, require each written key to be in the backend's accepted set with a
   fieldTable entry and an explicit range branch, and pair a declared (min, max)
   with the backend's range. Nothing that table asserted has gone unchecked —
   its subject left with the door. */

const errors = [];
const notes = [];

// 5. EVERY key any Settings panel writes is a key the backend ACCEPTS.
//    The four assertions above cover one panel's table; this covers every
//    panel, so a bool key in MemorySection or a cadence in the Decisions
//    panel cannot slip through because nobody looked at that file.
const panelWritten = panelKeys();
const panelRangesByFile = panelRanges();
for (const [key, files] of panelWritten) {
  if (!backend.allowedKeys.includes(key)) {
    errors.push(
      `${files.join(', ')} writes the brain-config key '${key}', which the backend does ` +
        'not accept — the control renders and the PUT is rejected as an unknown field.'
    );
  }
  if (!backend.fieldKeys.includes(key)) {
    errors.push(
      `${files.join(', ')} writes the brain-config key '${key}', which has no fieldTable ` +
        'entry — the key is not described, defaulted, or surfaced by the config API.'
    );
  }
}

// 6. A numeric key a panel writes must have an EXPLICIT range branch, for
//    the same reason the table's keys do: the fallback starts at 1, so a
//    key that means "0 means off" cannot be written on it.
for (const [key, files] of panelWritten) {
  if (!backend.numKeys.includes(key)) continue;
  if (!backend.explicitRangeKeys.includes(key)) {
    errors.push(
      `${files.join(', ')} writes the numeric key '${key}', which has no explicit range ` +
        'branch — it inherits the fallback range, which starts at 1.'
    );
  }
}

// 7. Where a panel declares a (min, max) next to the key it writes, the
//    declared range must lie inside the backend's range. Only checked when
//    the file declares exactly ONE range, because a file with several
//    numeric inputs cannot be paired with one of them without guessing.
for (const [key, files] of panelWritten) {
  if (!backend.numKeys.includes(key)) continue;
  const range = backend.ranges[key];
  if (!range || range.length !== 2) {
    errors.push(`the backend reports no range for '${key}' — the panel cannot be checked.`);
    continue;
  }
  for (const file of files) {
    const declared = panelRangesByFile.get(file);
    if (!declared || declared.length !== 1) continue;
    const [lo, hi] = declared[0];
    if (lo < range[0] || hi > range[1]) {
      errors.push(
        `${file} offers ${key} in [${lo}, ${hi}] but the backend accepts ` +
          `[${range[0]}, ${range[1]}] — the control offers values the backend refuses.`
      );
    }
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
  `\nAll ${panelWritten.size} panel-written key(s) are backend keys with a fieldTable ` +
    'entry, an explicit range branch, and a range the backend accepts.',
);
