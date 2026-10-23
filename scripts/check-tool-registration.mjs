#!/usr/bin/env node
/**
 * check-tool-registration.mjs — every registration module must be claimed.
 *
 * `tool_registrations/register_all()` hand-imports and hand-orders every
 * registration group. A module dropped into `tool_registrations/` that
 * defines `register()` but is never imported compiles, lints, passes every
 * static gate and starts fine — it is just DEAD: its tools never reach the
 * registry, and no door turns red because no other code names them. (The
 * same shape as check-sse-parity's handler-supply leg: an optional call on
 * a missing supplier validates and vanishes.)
 *
 * The check asks the directory what exists and the registration site what
 * is claimed, and fails on the difference in both directions:
 *   * a module with `def register(` that register_all does not call;
 *   * a `<name>.register()` call (or import) naming a module that is gone.
 *
 * Usage: node scripts/check-tool-registration.mjs
 * Exit 0: the census is non-empty and every registration module is claimed.
 * Exit 1: an unclaimed module, a call to a missing module, or an empty census.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'backend-py', 'app', 'services', 'tool_registrations');
const initPath = join(pkgDir, '__init__.py');

const initSrc = readFileSync(initPath, 'utf-8');
const registerAll = initSrc.slice(initSrc.indexOf('def register_all('));
if (registerAll.length < 20 || !registerAll.includes('register()')) {
  console.error('[check-tool-registration] FATAL: register_all() not found in __init__.py');
  process.exit(1);
}

// The imported names inside register_all's body — the only ones the calls
// below can legally reference. Both spellings occur: single-line and the
// parenthesized multi-line `from … import (a, b, …)` block the package
// imports use. The MODULE PATH is kept: register_all also calls groups
// living outside tool_registrations/ (bot_mode.dm, tools.tool_bridges,
// self_config_tools…), and a called name whose import comes from another
// package is not this check's business.
const importedFrom = new Map();
const importRe = /^[ \t]+from ([\w.]+) import[ \t]*(\([\s\S]*?\)|[^\n(]*)$/gm;
for (const m of registerAll.matchAll(importRe)) {
  const names = m[2].replace(/[()]/g, '');
  for (const name of names.split(',')) {
    const clean = name.trim().replace(/\s+as\s+\w+$/, '').trim();
    if (clean) importedFrom.set(clean, m[1]);
  }
}
const imported = (name) => importedFrom.has(name);
const isLocal = (name) => (importedFrom.get(name) ?? '').endsWith('tool_registrations');

const called = new Set();
const callRe = /^\s{4}(\w+)\.register\(\)/gm;
for (const m of registerAll.matchAll(callRe)) called.add(m[1]);

// Modules on disk that define their own top-level register().
const files = readdirSync(pkgDir).filter((f) => f.endsWith('.py') && f !== '__init__.py');
const providers = [];
for (const f of files) {
  const src = readFileSync(join(pkgDir, f), 'utf-8');
  if (/^def register\(/m.test(src)) providers.push(f.replace(/\.py$/, ''));
}
providers.sort();

const failures = [];
if (providers.length === 0) {
  failures.push('census is EMPTY — the scanner sees no `def register(` in any module; a gate that passes on zero matches is not a gate');
}
for (const mod of providers) {
  if (!imported(mod)) failures.push(`${mod}.py defines register() but register_all never imports it`);
  else if (!called.has(mod)) failures.push(`${mod}.py is imported but register_all never calls ${mod}.register()`);
}
for (const name of called) {
  // A call to a name imported from another package is a different module's
  // contract; only a LOCAL call can dangle against this directory.
  if (isLocal(name) && !providers.includes(name)) {
    failures.push(`register_all calls ${name}.register() but tool_registrations has no such module`);
  } else if (!isLocal(name) && !imported(name)) {
    failures.push(`register_all calls ${name}.register() without importing ${name}`);
  }
}

console.log(
  `[check-tool-registration] ${providers.length} registration module(s) on disk, ` +
    `${called.size} called by register_all, ${importedFrom.size} imported.`,
);
if (failures.length > 0) {
  console.error('[check-tool-registration] FAIL:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[check-tool-registration] ok — every registration module is imported and called.');
