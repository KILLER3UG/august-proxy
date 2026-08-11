#!/usr/bin/env node
/**
 * check-version-sync.mjs — Verify all 7 version sources are in sync.
 *
 * Usage: node scripts/check-version-sync.mjs
 * Exit 0: all versions match.
 * Exit 1: mismatch detected (prints details).
 *
 * Mismatch diagnostics compare every entry against the MAJORITY version
 * (most common among the successfully parsed sources), not the first file
 * discovered — a single stray file must not be treated as "correct" while
 * several are out of date.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sources = [
  {
    label: 'package.json',
    file: resolve(root, 'package.json'),
    extract: (content) => JSON.parse(content).version,
  },
  {
    label: 'frontend/desktop/package.json',
    file: resolve(root, 'frontend/desktop/package.json'),
    extract: (content) => JSON.parse(content).version,
  },
  {
    label: 'frontend/desktop/src-tauri/tauri.conf.json',
    file: resolve(root, 'frontend/desktop/src-tauri/tauri.conf.json'),
    extract: (content) => JSON.parse(content).version,
  },
  {
    label: 'frontend/desktop/src-tauri/Cargo.toml',
    file: resolve(root, 'frontend/desktop/src-tauri/Cargo.toml'),
    extract: (content) => {
      const match = content.match(/^version\s*=\s*"([^"]+)"/m);
      if (!match) throw new Error('Could not find version = "..." in Cargo.toml');
      return match[1];
    },
  },
  {
    label: 'frontend/desktop/src-tauri/Cargo.lock (august-desktop)',
    file: resolve(root, 'frontend/desktop/src-tauri/Cargo.lock'),
    extract: (content) => {
      const match = content.match(
        /^name = "august-desktop"[\s\S]*?^version = "([^"]+)"/m,
      );
      if (!match) throw new Error('Could not find august-desktop entry in Cargo.lock');
      return match[1];
    },
  },
  {
    label: 'package-lock.json (root)',
    file: resolve(root, 'package-lock.json'),
    extract: (content) => JSON.parse(content).version,
  },
  {
    label: 'package-lock.json (frontend/desktop)',
    file: resolve(root, 'package-lock.json'),
    extract: (content) => JSON.parse(content).packages?.['frontend/desktop']?.version,
  },
];

const versions = [];
let hasError = false;

for (const src of sources) {
  try {
    const content = readFileSync(src.file, 'utf-8');
    const version = src.extract(content);
    versions.push({ label: src.label, version });
  } catch (err) {
    versions.push({ label: src.label, version: `ERROR: ${err.message}` });
    hasError = true;
  }
}

const uniqueVersions = [...new Set(versions.map((v) => v.version))];

// Expected = the majority version among parsed sources (ties resolve to the
// first in file order — still surfaced as a mismatch elsewhere).
const parsed = versions.filter((v) => !v.version.startsWith('ERROR:'));
const counts = new Map();
for (const v of parsed) counts.set(v.version, (counts.get(v.version) || 0) + 1);
const expected = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

if (uniqueVersions.length === 1 && !hasError) {
  console.log(`✓ All versions in sync: ${uniqueVersions[0]}`);
  process.exit(0);
} else {
  console.error('ERROR: Version mismatch detected!\n');
  const maxLabel = Math.max(...versions.map((v) => v.label.length));
  for (const v of versions) {
    const padding = ' '.repeat(maxLabel - v.label.length + 2);
    const marker = v.version === expected ? ' ' : ' ← MISMATCH';
    console.error(`  ${v.label}:${padding}${v.version}${marker}`);
  }
  console.error(`\nAll ${sources.length} files must have the same version before committing.`);
  console.error('See AGENTS.md "Version files to bump together on desktop ship".');
  process.exit(1);
}
