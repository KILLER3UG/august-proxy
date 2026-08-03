#!/usr/bin/env node
/**
 * check-version-sync.mjs — Verify all 4 version files are in sync.
 *
 * Usage: node scripts/check-version-sync.mjs
 * Exit 0: all versions match.
 * Exit 1: mismatch detected (prints details).
 *
 * Part of the Better Harness Plan (Phase 1.4).
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

if (uniqueVersions.length === 1 && !hasError) {
  console.log(`✓ All versions in sync: ${uniqueVersions[0]}`);
  process.exit(0);
} else {
  console.error('ERROR: Version mismatch detected!\n');
  const maxLabel = Math.max(...versions.map((v) => v.label.length));
  for (const v of versions) {
    const padding = ' '.repeat(maxLabel - v.label.length + 2);
    const marker = v.version === uniqueVersions[0] ? ' ' : ' ← MISMATCH';
    console.error(`  ${v.label}:${padding}${v.version}${marker}`);
  }
  console.error('\nAll 4 files must have the same version before committing.');
  console.error('See AGENTS.md "Version files to bump together on desktop ship".');
  process.exit(1);
}
