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

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCHEMA_FILE = 'frontend/desktop/src/api/schemas/workbench.ts';
const DISPATCH_FILE = 'frontend/desktop/src/api/workbench/streamEvents.ts';

/**
 * Backend files that emit workbench SSE frames are DISCOVERED, not listed.
 *
 * This used to be a hand-written array of seven files, and that is exactly how
 * `recovery` hid for so long: the list was the truth about what the backend
 * emits, and the list was incomplete. `spawn_subagents_tool.py` was missing
 * from it, so the `subagentFanout` frame it emits was invisible to this
 * check — a hand-maintained list is a fourth list to keep in step, and the
 * one you forget.
 *
 * A file is an emitter when it CALLS `emit({... 'type': 'x' ...})`. That is
 * the shape, not a guess: a file that only mentions a frame name in a
 * docstring is not an emitter.
 */
function discoverEmitters() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__pycache__') continue;
        walk(full);
      } else if (entry.endsWith('.py')) {
        const text = readFileSync(full, 'utf8');
        // emit( { ... 'type': 'x' ... } — the dict may span lines.
        if (/emit\s*\(\s*\{[^}]{0,600}?['"]type['"]\s*:\s*f?['"][A-Za-z_]/.test(text)) {
          found.push(full);
        }
      }
    }
  };
  walk(resolve(root, 'backend-py/app'));
  return found;
}

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
  [
    'subagentFanout',
    'On the wire and documented in API_REFERENCE, and the backend persists it in the ' +
      'session event log — where the per-turn `turn_outcomes` row has no column for the ' +
      'children cap, the applied concurrency and the observed peak. The desktop ' +
      'transcript renders the subagent LANE and not the fanout budget readout, so the ' +
      'desktop UI drops it; that gap is tracked in docs/GAPS_AND_BUGS.md. An API ' +
      'consumer reading the SSE stream still receives it.',
  ],
]);

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

/** Every `'type': 'x'` literal the given Python emits. */
function backendFrames() {
  const out = new Map();
  for (const full of discoverEmitters()) {
    const rel = full.slice(root.length + 1).replace(/\\/g, '/');
    for (const name of frameLiteralsIn(readFileSync(full, 'utf8'))) {
      if (NOT_SSE_FRAMES.has(name)) continue;
      if (!out.has(name)) out.set(name, new Set());
      out.get(name).add(rel);
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

/**
 * The frame names inside the dicts that are actually PASSED TO `emit`.
 *
 * The literal has to be read from INSIDE the call, not from anywhere in the
 * file: a file that emits one frame usually also builds other dictionaries,
 * and a file-wide scan reads the provider wire shapes in it — Anthropic's
 * thinking block is `{'type': 'enabled', ...}`, which is not an SSE frame
 * and which a file-wide scan reported as one.
 */
function frameLiteralsIn(text) {
  const names = [];
  const re = /emit\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const body = text.slice(open, end + 1);
    const literal = body.match(/['"]type['"]\s*:\s*f?['"]([A-Za-z_][A-Za-z0-9_]*)['"]/);
    if (literal) names.push(literal[1]);
  }
  return names;
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

/**
 * Every handler the dispatcher INVOKES.
 *
 * `handlers.onX?.(...)` is an optional call, so a handler nobody supplies is a
 * no-op rather than a crash.
 */
function calledHandlers() {
  const text = read(DISPATCH_FILE);
  const out = new Set();
  for (const m of text.matchAll(/handlers\.(on[A-Za-z0-9]+)\?\./g)) out.add(m[1]);
  return out;
}

/** Files that DECLARE or CALL handlers rather than supply them. */
const NOT_A_SUPPLY = new Set([
  'frontend/desktop/src/types/workbench.ts',
  'frontend/desktop/src/api/workbench/streamEvents.ts',
]);

/** Every `.ts`/`.tsx` file under a directory. */
function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === 'gen') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Every handler name that at least one object literal SUPPLIES.
 *
 * A supply is `onX:` as an object property — NOT `onX?:`, which is how the
 * interface declares an optional handler. The two are one character apart and
 * the difference is the whole point: the declaration says "this may be
 * provided", the supply says "this IS provided".
 */
function suppliedHandlers() {
  const out = new Map();
  const base = resolve(root, 'frontend/desktop/src');
  for (const file of sourceFiles(base)) {
    const rel = file.slice(root.length + 1).split('\\').join('/');
    if (NOT_A_SUPPLY.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?<![.\w])on([A-Z][A-Za-z0-9]*)\s*:/g)) {
      const name = `on${m[1]}`;
      if (!out.has(name)) out.set(name, new Set());
      out.get(name).add(rel);
    }
  }
  return out;
}

const backend = backendFrames();
const schema = schemaFrames();
const dispatch = dispatchFrames();

const errors = [];

// 1. Emitted and neither schematised nor dispatched — a silent drop.
for (const [name, files] of backend) {
  if (schema.has(name) || dispatch.has(name)) continue;
  if (SCHEMA_ONLY.has(name)) {
    console.log(`OK   deliberately undispatched '${name}': ${SCHEMA_ONLY.get(name)}`);
    continue;
  }
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

// 7. A handler the dispatcher CALLS but nobody SUPPLIES — a silent no-op.
//
// The six checks above are all about the frame VOCABULARY, and none of them
// can see this. `recovery` was emitted, schematised AND dispatched — the
// dispatcher called `handlers.onRecovery?.(...)` — and the call did nothing,
// because no object anywhere passed an `onRecovery`. The optional call is a
// no-op, and a no-op typed as optional cannot be a compile error. The frame
// validated, reached the handler, and vanished.
//
// So: every handler the dispatcher invokes must be supplied by at least one
// object in the app. This is the check that would have caught it.
const called = calledHandlers();
const supplied = suppliedHandlers();
for (const name of called) {
  if (supplied.has(name)) continue;
  errors.push(
    `streamEvents.ts calls 'handlers.${name}?.(...)' but nothing in the app supplies ` +
      `'${name}:' — the call is a no-op, so the frame validates, reaches the ` +
      'handler and disappears. Supply the handler, or remove the call.'
  );
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
