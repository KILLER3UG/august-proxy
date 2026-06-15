// scripts/download-node-binaries.mjs
//
// Fetches a Node.js binary per platform target and writes it into
// frontend/desktop/src-tauri/binaries/node/node-<triple>[.exe].
// This lets the Tauri desktop build bundle Node as a sidecar.
//
// Usage: node scripts/download-node-binaries.mjs [--all] [--version=v22.20.0]
//
// --all downloads for Windows, macOS, and Linux; otherwise only the current
// host platform is downloaded.

import { mkdir, writeFile, stat, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'frontend/desktop/src-tauri/binaries');

const args = new Set(process.argv.slice(2));
const targetArg = [...args].find(a => a.startsWith('--target='))?.split('=')[1];
const allTargets = args.has('--all');
const explicitVersion = [...args].find(a => a.startsWith('--version='))?.split('=')[1]
    || process.env.AUGUST_NODE_VERSION
    || 'v22.20.0';

function tripleForWindowsX64() { return 'x86_64-pc-windows-msvc'; }
function tripleForMacX64() { return 'x86_64-apple-darwin'; }
function tripleForMacArm64() { return 'aarch64-apple-darwin'; }
function tripleForLinuxX64() { return 'x86_64-unknown-linux-gnu'; }
function tripleForLinuxArm64() { return 'aarch64-unknown-linux-gnu'; }

function targetsForHost() {
    if (process.platform === 'win32') return [{ platform: 'win', arch: 'x64', triple: tripleForWindowsX64() }];
    if (process.platform === 'darwin') {
        return process.arch === 'arm64'
            ? [{ platform: 'darwin', arch: 'arm64', triple: tripleForMacArm64() }]
            : [{ platform: 'darwin', arch: 'x64', triple: tripleForMacX64() }];
    }
    return process.arch === 'arm64'
        ? [{ platform: 'linux', arch: 'arm64', triple: tripleForLinuxArm64() }]
        : [{ platform: 'linux', arch: 'x64', triple: tripleForLinuxX64() }];
}

function allTargetsList() {
    return [
        { platform: 'win', arch: 'x64', triple: tripleForWindowsX64() },
        { platform: 'darwin', arch: 'x64', triple: tripleForMacX64() },
        { platform: 'darwin', arch: 'arm64', triple: tripleForMacArm64() },
        { platform: 'linux', arch: 'x64', triple: tripleForLinuxX64() },
        { platform: 'linux', arch: 'arm64', triple: tripleForLinuxArm64() }
    ];
}

function targetFromArg(value) {
    const [platform, arch] = value.split('-');
    if (!platform || !arch) return null;
    const triple = (() => {
        if (platform === 'win' && arch === 'x64') return tripleForWindowsX64();
        if (platform === 'darwin' && arch === 'x64') return tripleForMacX64();
        if (platform === 'darwin' && arch === 'arm64') return tripleForMacArm64();
        if (platform === 'linux' && arch === 'x64') return tripleForLinuxX64();
        if (platform === 'linux' && arch === 'arm64') return tripleForLinuxArm64();
        return null;
    })();
    return triple ? { platform, arch, triple } : null;
}

function archiveName(target, version) {
    if (target.platform === 'win') return `node-${version}-win-${target.arch}.zip`;
    return `node-${version}-${target.platform}-${target.arch}.tar.gz`;
}

function archiveUrl(target, version) {
    return `https://nodejs.org/dist/${version}/${archiveName(target, version)}`;
}

function binaryInArchive(target) {
    if (target.platform === 'win') return `node.exe`;
    return `node`;
}

function outputFileFor(target) {
    const ext = target.platform === 'win' ? '.exe' : '';
    return join(outDir, `node-${target.triple}${ext}`);
}

async function download(url, destination) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    await mkdir(dirname(destination), { recursive: true });
    await new Promise((resolveStream, rejectStream) => {
        const stream = createWriteStream(destination);
        Readable.fromWeb(response.body).pipe(stream);
        stream.on('finish', resolveStream);
        stream.on('error', rejectStream);
    });
}

function extract(archivePath, destDir) {
    return new Promise((resolveExtract, rejectExtract) => {
        const isZip = archivePath.toLowerCase().endsWith('.zip');
        const child = isZip && process.platform === 'win32'
            ? spawn('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`
            ], { stdio: 'inherit', shell: true })
            : spawn('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
        child.on('error', rejectExtract);
        child.on('close', code => code === 0 ? resolveExtract() : rejectExtract(new Error(`extractor exited with ${code}`)));
    });
}

async function fetchAndStage(target, version) {
    const url = archiveUrl(target, version);
    const archiveExt = target.platform === 'win' ? '.zip' : '.tar.gz';
    const archive = join(tmpdir(), `node-${version}-${target.triple}${archiveExt}`);
    const stage = join(tmpdir(), `node-stage-${target.triple}`);

    console.log(`[node-bins] downloading ${url}`);
    await download(url, archive);
    const stats = await stat(archive);
    console.log(`[node-bins]   ${(stats.size / 1_000_000).toFixed(1)} MB`);

    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    await extract(archive, stage);

    const extractedFolder = join(stage, `node-${version}-${target.platform}-${target.arch}`);
    const innerBin = target.platform === 'win'
        ? join(extractedFolder, binaryInArchive(target))
        : join(extractedFolder, 'bin', binaryInArchive(target));
    const outPath = outputFileFor(target);
    await mkdir(dirname(outPath), { recursive: true });
    await rename(innerBin, outPath);
    console.log(`[node-bins]   wrote ${outPath}`);

    await rm(archive, { force: true });
    await rm(stage, { recursive: true, force: true });
}

const targets = targetArg
    ? [targetFromArg(targetArg)].filter(Boolean)
    : allTargets
        ? allTargetsList()
        : targetsForHost();
await mkdir(outDir, { recursive: true });

await writeFile(join(outDir, 'README.md'), `# Bundled Node binaries

This directory is populated by:

\`\`\`bash
node scripts/download-node-binaries.mjs
\`\`\`

The Tauri desktop build expects a per-target \`node-\${triple}/node[\.exe]\` inside
this directory. Update the \`version\` field at the top of
\`scripts/download-node-binaries.mjs\` to upgrade the bundled Node.
`, 'utf8');

for (const target of targets) {
    await fetchAndStage(target, explicitVersion);
}

console.log(`[node-bins] done. wrote ${targets.length} binary(ies).`);
