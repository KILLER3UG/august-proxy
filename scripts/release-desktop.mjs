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

import { mkdir, writeFile, readFile, copyFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const root = resolve(process.cwd());
const releaseDir = resolve(root, 'releases/desktop');
const stagingDir = resolve(releaseDir, 'staging');
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
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        cwd: options.cwd || root,
        env: { ...process.env, ...(options.env || {}) }
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
    }
}

async function copyDir(src, dest, filter = () => true) {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (!filter(entry.name, srcPath)) continue;
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath, filter);
        } else if (entry.isFile()) {
            await mkdir(dirname(destPath), { recursive: true });
            await copyFile(srcPath, destPath);
        }
    }
}

function dirname(path) {
    return path.split(/[\\/]/).slice(0, -1).join('/') || '.';
}

function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = require('node:fs').createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function zipFolder(inputDir, outputFile) {
    await mkdir(dirname(outputFile), { recursive: true });
    await rm(outputFile, { force: true });
    if (process.platform === 'win32') {
        run('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `Compress-Archive -Path "${inputDir}" -DestinationPath "${outputFile}" -Force`
        ], { shell: true });
    } else {
        run('tar', ['-a', '-cf', outputFile, '-C', dirname(inputDir), basename(inputDir)]);
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

async function buildTauriApp() {
    if (!buildTauri) return;
    run('npm', ['run', 'tauri', '-w', 'frontend/desktop', 'build']);

    const tauriBundleDir = resolve(root, 'frontend/desktop/src-tauri/target/release/bundle');
    const latest = join(tauriBundleDir, 'latest.json');
    if (existsSync(latest)) {
        await copyFile(latest, join(releaseDir, 'latest.json'));
        console.log(`[release] copied ${latest}`);
    }
}

async function main() {
    if (bump) {
        const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
        pkg.version = version;
        await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
        console.log(`[release] bumped package version to ${version}`);
    }

    await mkdir(releaseDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });

    await buildWeb();
    await buildTauriApp();
    await stageBackend();

    const webZip = join(releaseDir, `web-${version}.zip`);
    const backendZip = join(releaseDir, `backend-${version}.zip`);

    await zipFolder(webDist, webZip);
    await zipFolder(join(stagingDir, 'backend'), backendZip);

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
        const ghArgs = ['release', 'create', `v${version}`, '--title', `August ${version}`, '--notes', `August desktop release ${version}`];
        if (existsSync(webZip)) ghArgs.push(webZip);
        if (existsSync(backendZip)) ghArgs.push(backendZip);
        if (existsSync(manifestPath)) ghArgs.push(manifestPath);
        const tauriLatest = join(releaseDir, 'latest.json');
        if (existsSync(tauriLatest)) ghArgs.push(tauriLatest);
        run('gh', ghArgs);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
