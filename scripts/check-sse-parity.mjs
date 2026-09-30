#!/usr/bin/env node
/**
 * check-sse-parity.mjs — the backend's SSE frame vocabulary vs the frontend's.
 *
 * The repo generates its REST types (`npm run gen:api`) but the SSE frame
 * union is hand-written in three places with nothing comparing them: a Zod
 * schema, the TS types, and the dispatcher. The switch in `streamEvents.ts` is
 * on a plain `string` with no `default`, so a frame the backend emits and the
 * frontend does not handle is not a compile error — it is a silent drop at
 * runtime, and the Zod layer is only a console.warn, so it is not even that.
 *
 * Measured drift when this was written:
 *   * `recovery` — the unified self-correction frame
 *     ({kind, attempt, outcome, degraded}) was accepted by the Zod schema and
 *     then DROPPED by the dispatcher, so no rescue the harness performed was
 *     ever visible in the UI;
 *   * `subagentTodos` — same shape, same silence;
 *   * eleven events the dispatcher handles were absent from the schema, so
 *     every one of them logged a schema-mismatch warning on a frame that was in
 *     fact correct.
 *
 * That is three hand-maintained lists and no check, which is the same shape of
 * problem check-naming and check-docs-sync exist to close.
 *
 * Usage: node scripts/check-sse-parity.mjs
 * Exit 0: every frame the backend emits is known to the schema and the dispatcher.
 * Exit 1: a frame is emitted and unhandled, handled and unschematised, or the
 *         allowlist still names something that is no longer true.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCHEMA_FILE = 'frontend/desktop/src/api/schemas/workbench.ts';
const DISPATCH_FILE = 'frontend/desktop/src/api/workbench/streamEvents.ts';

/** Backend files that emit workbench SSE frames. */
const BACKEND_EMITTERS = [
  'backend-py/app/services/workbench/workbench.py',
  'backend-py/app/services/workbench/subagent.py',
  'backend-py/app/services/workbench/subagent_fanout.py',
  'backend-py/app/services/workbench/loop/events.py',
  'backend-py/app/services/workbench/loop/recovery.py',
  'backend-py/app/services/workbench/loop/exec.py',
  'backend-py/app/services/workbench/loop/guards.py',
];

/**
 * `'type': 'x'` literals that are NOT SSE frames: JSON-Schema type keywords,
 * OpenAI/Anthropic wire events that pass through untouched, and the code-mode
 * envelope. Listing them is deliberate — a blanket filter would hide a real
 * frame the day one of these names changed meaning.
 */
const NOT_SSE_FRAMES = new Set([
  'array', 'base64', 'battery', 'bearer', 'boolean', 'dm', 'ephemeral', 'function',
  'function_call', 'function_call_output', 'image', 'image_url', 'integer', 'invalid_request_error',
  'message', 'message_delta', 'message_start', 'message_stop', 'none', 'number', 'object',
  'output_text', 'preview_start', 'string', 'tool_error', 'tool_result', 'tool_use', 'url',
  'content_block_delta', 'content_block_start', 'content_block_stop',
  'input_json_delta', 'reasoning', 'text_delta', 'thinking_delta', 'keepalive',
]);

/**
 * Frames the backend emits that the frontend deliberately does not DISPATCH.
 * Each needs a reason; an unexplained entry here is how the next silent drop
 * gets authorised. Keep this list as short as the design allows.
 */
const SCHEMA_ONLY = new Map([
  [
    'subagentTodos',
    'Carried on the subagent block; routed by apply-subagent-event, not by this switch.',
  ],
]);

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

/** Every `'type': 'x'` literal the given Python emits. */
function backendFrames() {
  const out = new Map();
  for (const rel of BACKEND_EMITTERS) {
    if (!existsSync(resolve(root, rel))) continue;
    const text = read(rel);
    const re = /['"]type['"]\s*:\s*f?['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (NOT_SSE_FRAMES.has(m[1])) continue;
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1]).add(rel);
    }
  }
  // _emitRecovery/_emitCompactionEvent pass `kind`/`type` as arguments, not a
  // dict key, so recover those two names explicitly.
  const rec = read('backend-py/app/services/workbench/loop/events.py');
  for (const name of ['recovery', 'compaction']) {
    if (rec.includes(`'type': '${name}'`)) {
      if (!out.has(name)) out.set(name, new Set());
      out.get(name).add('backend-py/app/services/workbench/loop/events.py');
    }
  }
  return out;
}

/** Every frame name the Zod schema accepts, from z.literal AND z.enum. */
function schemaFrames() {
  const text = read(SCHEMA_FILE);
  const out = new Set();
  for (const m of text.matchAll(/z\.literal\(\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\)/g)) out.add(m[1]);
  for (const block of text.matchAll(/z\.enum\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    for (const s of block[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) out.add(s[1]);
  }
  return out;
}

/** Every `case 'x':` the dispatcher handles. */
function dispatchFrames() {
  const text = read(DISPATCH_FILE);
  const out = new Set();
  for (const m of text.matchAll(/case\s+'([A-Za-z_][A-Za-z0-9_]*)'\s*:/g)) out.add(m[1]);
  return out;
}

const backend = backendFrames();
const schema = schemaFrames();
const dispatch = dispatchFrames();

const errors = [];

// 1. Emitted and neither schematised nor dispatched — a silent drop.
for (const [name, files] of backend) {
  if (schema.has(name) || dispatch.has(name)) continue;
  errors.push(
    `backend emits '${name}' (${[...files].join(', ')}) but the frontend neither ` +
      'schemas nor dispatches it — the frame is dropped at runtime with no error'
  );
}

// 2. Emitted and dispatched but not schematised — a console.warn on every frame.
for (const [name, files] of backend) {
  if (dispatch.has(name) && !schema.has(name)) {
    errors.push(
      `backend emits '${name}' (${[...files].join(', ')}) and the dispatcher handles it, ` +
        'but the Zod schema does not list it — every frame logs a false schema-mismatch warning'
    );
  }
}

// 3. Emitted and schematised but NOT dispatched — THE SILENT DROP.
//
// This is the check that matters and it is separate from (1) on purpose. An
// earlier version folded it into (1) by skipping any name the backend emits,
// which quietly made the whole check vacuous for exactly the case it was
// written for: `recovery` is emitted and schematised, so removing its
// dispatcher case still passed. Found by deleting the case and re-running.
for (const [name, files] of backend) {
  if (!schema.has(name) || dispatch.has(name)) continue;
  const why = SCHEMA_ONLY.get(name);
  if (why) {
    console.log(`OK   deliberately undispatched '${name}': ${why}`);
  } else {
    errors.push(
      `backend emits '${name}' (${[...files].join(', ')}) and the Zod schema accepts it, ` +
        'but streamEvents.ts has NO case for it — the frame passes validation and is then ' +
        'dropped with no error and no UI. Add a dispatcher case, or record the decision in ' +
        'SCHEMA_ONLY with the reason.'
    );
  }
}

// 4. Schematised, not dispatched, and the backend no longer emits it — a stale entry.
for (const name of schema) {
  if (backend.has(name) || dispatch.has(name)) continue;
  const why = SCHEMA_ONLY.get(name);
  if (!why) {
    errors.push(
      `the schema accepts '${name}' but neither the backend emits it nor the dispatcher ` +
        'handles it. Remove it from the schema, or record why in SCHEMA_ONLY.'
    );
  }
}

// 5. Dispatched, not schematised, and the backend no longer emits it — a legacy
//    alias or a frame from a stream this switch does not serve.
const dispatchOnly = [...dispatch].filter((n) => !schema.has(n) && !backend.has(n));
if (dispatchOnly.length) {
  console.log(
    `OK   ${dispatchOnly.length} dispatcher case(s) the backend scanner does not attribute ` +
      `to this stream (legacy aliases, frames from another stream): ${dispatchOnly.join(', ')}`
  );
}

// 6. Stale allowlist entries: documented as deliberately undispatched, but the
//    dispatcher now handles them — the allowlist is lying about the code.
for (const [name] of SCHEMA_ONLY) {
  if (dispatch.has(name)) {
    errors.push(
      `SCHEMA_ONLY lists '${name}' as undispatched, but streamEvents.ts now has a case ` +
        'for it. Remove the entry — the allowlist has to describe the code, not intent.'
    );
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`FAIL  ${e}`);
  console.error(
    `\n${errors.length} SSE parity problem(s). Each is a frame the backend emits and the ` +
      'frontend drops, or a frame that logs a false warning. Fix the dispatcher or the ' +
      'schema (both are hand-maintained), and if a frame is deliberately undispatched, ' +
      'record why in SCHEMA_ONLY.'
  );
  process.exit(1);
}

console.log(
  `\nAll ${backend.size} backend SSE frame(s) are schematised and dispatched; ` +
    `${dispatch.size} dispatcher case(s) accounted for.`
);
