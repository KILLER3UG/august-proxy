// scripts/sync-tauri-version.mjs
//
// Called automatically by the "version" npm script after `npm version <bump>`.
// Reads the new version from package.json (via npm_package_version env var)
// and writes it into frontend/desktop/src-tauri/tauri.conf.json.
//
// Also updates the hardcoded version string in UpdateSection.tsx.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const newVersion = process.env.npm_package_version;
if (!newVersion) {
  console.error('[sync-tauri-version] npm_package_version not set — skipping');
  process.exit(0);
}

// ── 1. Sync tauri.conf.json ────────────────────────────────────────
const tauriConfPath = join(root, 'frontend/desktop/src-tauri/tauri.conf.json');
let tauriConf = readFileSync(tauriConfPath, 'utf8');
const oldLine = tauriConf.match(/"version":\s*"[^"]+"/);
if (oldLine) {
  tauriConf = tauriConf.replace(oldLine[0], `"version": "${newVersion}"`);
  writeFileSync(tauriConfPath, tauriConf);
  console.log(`[sync-tauri-version] tauri.conf.json → ${newVersion}`);
}

// ── 2. Sync UpdateSection.tsx hardcoded display ────────────────────
const updateSectionPath = join(root, 'frontend/desktop/src/sections/settings/UpdateSection.tsx');
let updateSection = readFileSync(updateSectionPath, 'utf8');
const versionTag = updateSection.match(/August Proxy v\d+\.\d+\.\d+/);
if (versionTag) {
  updateSection = updateSection.replace(versionTag[0], `August Proxy v${newVersion}`);
  writeFileSync(updateSectionPath, updateSection);
  console.log(`[sync-tauri-version] UpdateSection.tsx → v${newVersion}`);
}
