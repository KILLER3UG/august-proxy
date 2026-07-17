// scripts/release-desktop.mjs
//
// Builds the desktop release assets and writes a GitHub-release manifest used
// by the custom asset updater.
//
// Usage:
//   node scripts/release-desktop.mjs patch
//   node scripts/release-desktop.mjs minor
//   node scripts/release-desktop.mjs --publish
//
// The script:
//   1) builds the web UI
//   2) stages backend code and node_modules
//   3) zips web and backend assets
//   4) computes sha256 checksums
//   5) writes august-desktop-manifest.json
//   6) optionally publishes to GitHub Releases via gh
//
// The generated manifest is intended for the custom sidecar updater in
// backend/services/desktop/asset-updater.js.

import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { existsSync, createReadStream, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(process.cwd());
const releaseDir = resolve(root, 'releases/desktop');
const webDist = resolve(root, 'web-dist');
const backendDir = resolve(root, 'backend');
const nodeModules = resolve(root, 'node_modules');
const packageJsonPath = resolve(root, 'package.json');
const manifestPath = join(releaseDir, 'august-desktop-manifest.json');

const args = new Set(process.argv.slice(2));
const publish = args.has('--publish');
const buildTauri = args.has('--tauri');
const bump = getBumpFromArgs();
const version = getVersionFromArgs() || (bump ? bumpVersion(await readVersion(), bump) : await readVersion());

function getVersionFromArgs() {
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith('--version=')) return arg.slice('--version='.length);
    }
    return null;
}

function getBumpFromArgs() {
    for (const arg of process.argv.slice(2)) {
        if (arg === 'patch' || arg === 'minor' || arg === 'major') return arg;
    }
    return null;
}

function bumpVersion(current, bump) {
    const parts = current.split('.').map(Number);
    if (bump === 'major') return [parts[0] + 1, 0, 0].join('.');
    if (bump === 'minor') return [parts[0], parts[1] + 1, 0].join('.');
    return [parts[0], parts[1], parts[2] + 1].join('.');
}

async function readVersion() {
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    return pkg.version;
}

function run(command, args, options = {}) {
    // Use shell only when the command has no file extension (e.g. npm, gh).
    // Commands with an extension like powershell.exe must NOT go through cmd.exe
    // as that mangles complex argument strings (long PowerShell scripts).
    const useShell = process.platform === 'win32' && !command.includes('.');

    const result = spawnSync(command, args, {
        stdio: 'inherit',
        cwd: options.cwd || root,
        env: { ...process.env, ...(options.env || {}) },
        shell: useShell
    });
    if (result.status !== 0) {
        const exit = result.signal || result.status || 'unknown';
        throw new Error(`${command} ${args.join(' ')} exited with ${exit}`);
    }
}

function dirname(path) {
    return path.split(/[\\/]/).slice(0, -1).join('/') || '.';
}

function powershellZip(script, env = {}) {
    run('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script
    ], { env });
}

function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function zipFolder(inputDir, outputFile, prefix = '') {
    await mkdir(dirname(outputFile), { recursive: true });
    await rm(outputFile, { force: true });
    if (process.platform === 'win32') {
        powershellZip(`
\$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
\$out = \$env:AUGUST_ZIP_OUTPUT
\$inputDir = \$env:AUGUST_ZIP_INPUT
\$prefix = \$env:AUGUST_ZIP_PREFIX
\$zip = [System.IO.Compression.ZipFile]::Open(\$out, 'Create')
try {
    \$compression = [System.IO.Compression.CompressionLevel]::Optimal
    \$sourceRoot = (Resolve-Path -LiteralPath \$inputDir).Path.TrimEnd('\\','/') + '\\'
    Get-ChildItem -LiteralPath \$inputDir -Recurse -File | ForEach-Object {
        \$rel = \$_.FullName.Substring(\$sourceRoot.Length).Replace('\\','/')
        \$entryName = if (\$prefix) { "\$prefix/\$rel" } else { \$rel }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(\$zip, \$_.FullName, \$entryName, \$compression) | Out-Null
    }
} finally {
    \$zip.Dispose()
}
`, {
            AUGUST_ZIP_OUTPUT: outputFile,
            AUGUST_ZIP_INPUT: inputDir,
            AUGUST_ZIP_PREFIX: prefix
        });
    } else {
        run('tar', ['-a', '-cf', outputFile, '-C', inputDir, '.']);
    }
}

async function zipBackend(outputFile) {
    await mkdir(dirname(outputFile), { recursive: true });
    await rm(outputFile, { force: true });
    if (process.platform === 'win32') {
        powershellZip(`
\$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
\$out = \$env:AUGUST_ZIP_OUTPUT
\$backend = \$env:AUGUST_ZIP_BACKEND
\$nodeModules = \$env:AUGUST_ZIP_NODE_MODULES
\$zip = [System.IO.Compression.ZipFile]::Open(\$out, 'Create')
function Add-Directory(\$source, \$prefix) {
    \$sourceRoot = (Resolve-Path -LiteralPath \$source).Path.TrimEnd('\\','/') + '\\'
    Get-ChildItem -LiteralPath \$source -Recurse -File | ForEach-Object {
        \$rel = \$_.FullName.Substring(\$sourceRoot.Length).Replace('\\','/')
        \$entryName = "\$prefix/\$rel".Replace('\\','/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(\$zip, \$_.FullName, \$entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
}
try {
    Add-Directory \$backend 'backend'
    Add-Directory \$nodeModules 'backend/node_modules'
} finally {
    \$zip.Dispose()
}
`, {
            AUGUST_ZIP_OUTPUT: outputFile,
            AUGUST_ZIP_BACKEND: backendDir,
            AUGUST_ZIP_NODE_MODULES: nodeModules
        });
    } else {
        run('tar', ['-a', '-cf', outputFile, '-C', root, 'backend', 'node_modules']);
    }
}

function publicUrl(filename) {
    return `https://github.com/KILLER3UG/august-proxy/releases/download/v${version}/${filename}`;
}

async function buildWeb() {
    run('npm', ['run', 'build:web']);
}

async function stageBackend() {
    const out = join(stagingDir, 'backend');
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await copyDir(backendDir, out, name => !['data', 'node_modules', '.cache'].includes(name));
    await copyDir(nodeModules, join(out, 'node_modules'));
}

async function syncPackageVersions(nextVersion) {
    // Root package.json
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    pkg.version = nextVersion;
    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

    // Desktop package.json
    const desktopPkgPath = resolve(root, 'frontend/desktop/package.json');
    if (existsSync(desktopPkgPath)) {
        const desktopPkg = JSON.parse(await readFile(desktopPkgPath, 'utf8'));
        desktopPkg.version = nextVersion;
        await writeFile(desktopPkgPath, `${JSON.stringify(desktopPkg, null, 2)}\n`);
    }

    // Tauri config (source of truth for updater version compare)
    const tauriConfPath = resolve(root, 'frontend/desktop/src-tauri/tauri.conf.json');
    if (existsSync(tauriConfPath)) {
        const conf = JSON.parse(await readFile(tauriConfPath, 'utf8'));
        conf.version = nextVersion;
        await writeFile(tauriConfPath, `${JSON.stringify(conf, null, 2)}\n`);
    }

    // Cargo.toml crate version
    const cargoPath = resolve(root, 'frontend/desktop/src-tauri/Cargo.toml');
    if (existsSync(cargoPath)) {
        let cargo = await readFile(cargoPath, 'utf8');
        cargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
        await writeFile(cargoPath, cargo);
    }

    console.log(`[release] synced package versions to ${nextVersion}`);
}

function findLatestJson(tauriBundleDir) {
    const candidates = [
        join(tauriBundleDir, 'latest.json'),
        join(tauriBundleDir, 'nsis', 'latest.json'),
        join(tauriBundleDir, 'msi', 'latest.json'),
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    // Walk one level for any latest.json Tauri may have written.
    try {
        for (const name of readdirSync(tauriBundleDir)) {
            const nested = join(tauriBundleDir, name, 'latest.json');
            if (existsSync(nested)) return nested;
        }
    } catch { /* ignore */ }
    return null;
}

async function prepareTauriUpdaterManifest(nextVersion) {
    const tauriBundleDir = resolve(root, 'frontend/desktop/src-tauri/target/release/bundle');
    const found = findLatestJson(tauriBundleDir);
    if (!found) {
        console.warn('[release] latest.json not found — updater notices will not work until createUpdaterArtifacts + signing keys are configured');
        return null;
    }

    const latest = JSON.parse(await readFile(found, 'utf8'));
    latest.version = nextVersion;

    const nsisDir = join(tauriBundleDir, 'nsis');
    const msiDir = join(tauriBundleDir, 'msi');
    let windowsUrl = null;
    if (existsSync(nsisDir)) {
        const exe = readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe'));
        if (exe) windowsUrl = publicUrl(exe);
    }
    if (!windowsUrl && existsSync(msiDir)) {
        const msi = readdirSync(msiDir).find((f) => f.endsWith('.msi'));
        if (msi) windowsUrl = publicUrl(msi);
    }

    if (windowsUrl && latest.platforms) {
        for (const key of Object.keys(latest.platforms)) {
            if (key.startsWith('windows')) {
                latest.platforms[key].url = windowsUrl;
            }
        }
    }

    const out = join(releaseDir, 'latest.json');
    await writeFile(out, `${JSON.stringify(latest, null, 2)}\n`);
    console.log(`[release] wrote updater manifest ${out}`);
    return out;
}

async function buildTauriApp() {
    if (!buildTauri) return;
    run('npm', ['run', 'tauri', '-w', 'frontend/desktop', 'build']);
    await prepareTauriUpdaterManifest(version);
}

async function main() {
    if (bump || args.has('--version') || [...args].some((a) => a.startsWith('--version='))) {
        await syncPackageVersions(version);
    }

    await mkdir(releaseDir, { recursive: true });

    const webZip = join(releaseDir, `web-${version}.zip`);
    const backendZip = join(releaseDir, `backend-${version}.zip`);

    await buildWeb();
    await buildTauriApp();
    await zipBackend(backendZip);

    await zipFolder(webDist, webZip);

    const webSha = await sha256(webZip);
    const backendSha = await sha256(backendZip);

    const manifest = {
        version,
        web: {
            url: publicUrl(`web-${version}.zip`),
            sha256: webSha,
            path: 'web'
        },
        backend: {
            url: publicUrl(`backend-${version}.zip`),
            sha256: backendSha,
            path: 'backend'
        }
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`[release] version ${version}`);
    console.log(`[release] web ${webZip}`);
    console.log(`[release] backend ${backendZip}`);
    console.log(`[release] manifest ${manifestPath}`);

    if (publish) {
        const title = `August ${version}`;
        const notes = `August desktop release ${version}`;
        // When shell: true is active (Windows, extensionless commands), cmd.exe
        // splits unquoted spaces into separate arguments, so we quote them.
        const ghArgs = ['release', 'create', `v${version}`, '--title', `"${title}"`, '--notes', `"${notes}"`];
        if (existsSync(webZip)) ghArgs.push(webZip);
        if (existsSync(backendZip)) ghArgs.push(backendZip);
        if (existsSync(manifestPath)) ghArgs.push(manifestPath);
        const tauriLatest = join(releaseDir, 'latest.json');
        if (existsSync(tauriLatest)) ghArgs.push(tauriLatest);

        // Also upload the Tauri native installers (+ .sig updater artifacts)
        const tauriBundleDir = resolve(root, 'frontend/desktop/src-tauri/target/release/bundle');
        const msiDir = join(tauriBundleDir, 'msi');
        const nsisDir = join(tauriBundleDir, 'nsis');
        if (existsSync(msiDir)) {
            for (const f of readdirSync(msiDir)) ghArgs.push(join(msiDir, f));
        }
        if (existsSync(nsisDir)) {
            for (const f of readdirSync(nsisDir)) ghArgs.push(join(nsisDir, f));
        }

        run('gh', ghArgs);
        console.log(`[release] published GitHub release v${version} (includes latest.json for in-app update notices)`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
