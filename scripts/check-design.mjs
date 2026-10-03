#!/usr/bin/env node
/* ── check-design.mjs — design-drift guardrail (audit P0#2) ───────────────
 *
 * The desktop UI accumulated five habits that each defeat a system the
 * codebase already has: a rem type scale, theme tokens instead of raw hex,
 * shared primitives under src/components/ui, one API client, and no
 * inline style objects. None of them is wrong in isolation; all of them
 * make the UI inconsistent, and a linter message alone did not stop them.
 *
 * This check does NOT demand a cleanup — that would be hundreds of files of
 * churn. Like check-naming.mjs it is a RATCHET: it fails only on violations
 * that are NOT in the checked-in baseline (design-baseline.json), so the
 * debt stays visible and shrinkable while new drift is impossible to merge.
 * Run with --update to regenerate the baseline, but only after an
 * intentional sweep — never to silence a finding.
 *
 * Identity note: a baseline entry is "path:match", deliberately WITHOUT the
 * line number. Line numbers churn on every unrelated edit above a violation,
 * which would make this fail PRs that did not touch the violation at all.
 * The failure output still prints the line, which is what you need to fix it.
 *
 * Usage:  node scripts/check-design.mjs [--update] [--list]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const SRC = resolve(REPO, 'frontend', 'desktop', 'src');
const BASELINE = join(SCRIPT_DIR, 'design-baseline.json');
const UPDATE = process.argv.includes('--update');
const LIST = process.argv.includes('--list');

/**
 * Each rule is one habit. `re` matches a violation on a single line;
 * `exclude` drops paths (posix, relative to REPO) that are the SYSTEM'S
 * home for that construct — a raw <button> is the point of
 * src/components/ui/button.tsx, and a raw fetch() is the point of src/api.
 */
const RULES = [
  {
    id: 'px-type',
    re: /text-\[\d+(\.\d+)?px\]/g,
    advice:
      'Use the rem type scale (text-3xs / text-2xs / text-xs / text-sm / …) or an exact rem arbitrary value.\n' +
      '  A px font-size ignores the data-text-size root scaling in styles.css. eslint bans this too; this is the second net.',
  },
  {
    id: 'hex-color',
    // 6- and 8-digit forms. The trailing \b is what keeps #aabbccdd from
    // matching as its 6-digit prefix.
    re: /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g,
    advice:
      'Use a theme token (bg-background, text-muted-foreground, border-border, …) so light/dark stay in step.\n' +
      '  Palette values live in styles.css and the Tailwind theme.',
  },
  {
    id: 'raw-button',
    re: /<button\b/g,
    exclude: ['frontend/desktop/src/components/ui/'],
    advice:
      'Use the Button primitive from @/components/ui/button — it carries the focus ring, variant and size scale.',
  },
  {
    id: 'raw-fetch',
    // No `\s*` before the paren: prose like "the iframe to fetch (the base
    // URL…)" in a doc comment is not a call site, and every real one is
    // written `fetch(`.
    re: /\bfetch\(/g,
    // src/api IS the client layer; anything else should go through it.
    exclude: ['frontend/desktop/src/api/'],
    advice:
      "Use api.get / api.post from @/api/client — it owns the base URL, auth and error normalization.\n" +
      '  A bare fetch() bypasses all three.',
  },
  {
    id: 'inline-style',
    re: /style=\{\{/g,
    advice:
      'Move the styling to a className. Inline objects cannot use theme tokens or be overridden by the\n' +
      '  variant system, and they re-render on every parent render.',
  },
  {
    id: 'raw-status-color',
    // Raw Tailwind palette status classes: they bypass the --dt-*-rgb
    // theme tokens, so the -400 shades fail contrast in light mode
    // (green-400 on white = 1.74:1). Use success/warning/danger/info
    // (+ -fg for text) — registered in tailwind.config.cjs. The blue/
    // violet families are deliberately NOT banned here: they are the
    // categorical accent palette (per-model chart hues, provider chips),
    // not status colors.
    re: /\b(?:[a-z-]+:)*(?:text|bg|border|ring|divide|from|to|via|fill|stroke)-(?:green|emerald|red|rose|amber|yellow|lime|orange)-\d{3}\b/g,
    advice:
      'Use the status tokens: success / warning / danger / info (base for fills and borders,\n' +
      '  -fg variants for text) — they re-theme light/dark. The raw Tailwind warm palettes\n' +
      '  do not follow the theme and fail contrast on light backgrounds.',
  },
];

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** relpath:match for every violation, plus a line number for reporting. */
function collect() {
  const entries = [];
  for (const file of walkFiles(SRC)) {
    const rel = relative(REPO, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of RULES) {
        if (rule.exclude?.some((frag) => rel.includes(frag))) continue;
        // Fresh regex per line: the /g flag is stateful across calls.
        for (const m of line.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
          entries.push({ key: `${rel}:${m[0]}`, rule: rule.id, rel, line: i + 1, match: m[0] });
        }
      }
    }
  }
  return entries;
}

const found = collect();
const counts = Object.fromEntries(RULES.map((r) => [r.id, 0]));
for (const e of found) counts[e.rule] += 1;

if (LIST) {
  for (const e of found.sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`${e.rule}\t${e.rel}:${e.line}\t${e.match}`);
  }
  process.exit(0);
}

const current = new Set(found.map((e) => e.key));

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify([...current].sort(), null, 2) + '\n');
  const summary = RULES.map((r) => `${r.id}=${counts[r.id]}`).join(' ');
  console.log(`[check-design] baseline updated — ${current.size} known violation(s): ${summary}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8'))) : new Set();
const fresh = found.filter((e) => !baseline.has(e.key));

if (fresh.length === 0) {
  const summary = RULES.map((r) => `${r.id}=${counts[r.id]}`).join(' ');
  console.log(`[check-design] ok — no new design drift (${current.size} baselined: ${summary})`);
  process.exit(0);
}

console.error(`[check-design] FAIL — ${fresh.length} NEW design-drift violation(s):\n`);
for (const rule of RULES) {
  const hits = fresh.filter((e) => e.rule === rule.id);
  if (hits.length === 0) continue;
  console.error(`  ${rule.id} (${hits.length}):`);
  for (const h of hits.slice(0, 20)) console.error(`    ${h.rel}:${h.line}  ${h.match}`);
  if (hits.length > 20) console.error(`    … and ${hits.length - 20} more`);
  console.error(`  ${rule.advice}\n`);
}
console.error(
  'If a violation is genuinely intended, fix the habit rather than the baseline.\n' +
    'To accept an intentional sweep, run: node scripts/check-design.mjs --update',
);
process.exit(1);
