// scripts/sync-tauri-version.mjs
//
// Called automatically by the "version" npm script after `npm version <bump>`.
// Reads the new version from package.json (via npm_package_version env var)
// and writes it into the three other files that AGENTS.md requires to stay in
// sync on desktop ship:
//   - frontend/desktop/package.json
//   - frontend/desktop/src-tauri/tauri.conf.json
//   - frontend/desktop/src-tauri/Cargo.toml
//
// Mirrors the sync logic in scripts/release-desktop.mjs (syncPackageVersions)
// so `npm version <bump>` and the formal release flow cannot drift apart.
//
// Note: UpdateSection.tsx renders the version dynamically from the Tauri
// updater state (`August Proxy v{currentVersion}`), so no source string needs
// patching here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const newVersion = process.env.npm_package_version;
if (!newVersion) {
  console.error('[sync-tauri-version] npm_package_version not set — skipping');
  process.exit(0);
}

// ── 1. Desktop package.json ───────────────────────────────────────
const desktopPkgPath = join(root, 'frontend/desktop/package.json');
if (existsSync(desktopPkgPath)) {
  const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
  desktopPkg.version = newVersion;
  writeFileSync(desktopPkgPath, `${JSON.stringify(desktopPkg, null, 2)}\n`);
  console.log(`[sync-tauri-version] frontend/desktop/package.json → ${newVersion}`);
}

// ── 2. Tauri config (source of truth for updater version compare) ──
const tauriConfPath = join(root, 'frontend/desktop/src-tauri/tauri.conf.json');
if (existsSync(tauriConfPath)) {
  const conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
  conf.version = newVersion;
  writeFileSync(tauriConfPath, `${JSON.stringify(conf, null, 2)}\n`);
  console.log(`[sync-tauri-version] tauri.conf.json → ${newVersion}`);
}

// ── 3. Cargo.toml crate version ───────────────────────────────────
const cargoPath = join(root, 'frontend/desktop/src-tauri/Cargo.toml');
if (existsSync(cargoPath)) {
  let cargo = readFileSync(cargoPath, 'utf8');
  cargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${newVersion}"`);
  writeFileSync(cargoPath, cargo);
  console.log(`[sync-tauri-version] Cargo.toml → ${newVersion}`);
}
