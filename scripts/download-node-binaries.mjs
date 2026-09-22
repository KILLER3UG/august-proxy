// scripts/download-node-binaries.mjs
//
// Fetches a Node.js binary per platform target and writes it into
// frontend/desktop/src-tauri/binaries/node-<triple>[.exe].
// This lets the Tauri desktop build bundle Node as a sidecar.
//
// Usage: node scripts/download-node-binaries.mjs [--all] [--version=v22.20.0]
//
// --all downloads for Windows, macOS, and Linux; otherwise only the current
// host platform is downloaded.

import { mkdir, writeFile, stat, copyFile, rename, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createWriteStream, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'frontend/desktop/src-tauri/binaries');

const args = process.argv.slice(2);
if (args.filter(arg => arg === '--all').length > 1) throw new Error('multiple --all selectors');
const unknownArgs = args.filter(arg => !arg.startsWith('--target=') && !arg.startsWith('--version=') && arg !== '--all');
if (unknownArgs.length) throw new Error(`unknown argument(s): ${unknownArgs.join(', ')}`);
const targetValues = args.filter(arg => arg.startsWith('--target='));
if (targetValues.length > 1) throw new Error('multiple --target selectors');
const targetArg = targetValues[0]?.split('=')[1];
if (targetValues[0] && !targetArg) throw new Error('--target requires a value using --target=<platform-arch>');
if (targetArg && args.includes('--all')) throw new Error('choose either --target or --all, not both');
const allTargets = args.includes('--all');
const versionValues = args.filter(arg => arg.startsWith('--version='));
if (versionValues.length > 1) throw new Error('multiple --version selectors');
const versionValue = versionValues[0]?.split('=')[1];
if (versionValues[0] && !versionValue) throw new Error('--version requires a value using --version=<version>');
const explicitVersion = versionValue
    || process.env.AUGUST_NODE_VERSION
    || 'v22.20.0';
const NODE_SHA256 = {
    'v22.20.0': {
        'x86_64-pc-windows-msvc': 'bb819d6eb8f5bfda294bbc83a7e4ec6539da67c4233d54b0d655b9248b15e29d',
        'x86_64-apple-darwin': '00df9c5df3e4ec6848c26b70fb47bf96492f342f4bed6b17f12d99b3a45eeecc',
        'aarch64-apple-darwin': 'cc04a76a09f79290194c0646f48fec40354d88969bec467789a5d55dd097f949',
        'x86_64-unknown-linux-gnu': 'eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29',
        'aarch64-unknown-linux-gnu': '4181609e03dcb9880e7e5bf956061ecc0503c77a480c6631d868cb1f65a2c7dd',
    },
};

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
    const triple = (() => {
        if (platform === 'win' && arch === 'x64') return tripleForWindowsX64();
        if (platform === 'darwin' && arch === 'x64') return tripleForMacX64();
        if (platform === 'darwin' && arch === 'arm64') return tripleForMacArm64();
        if (platform === 'linux' && arch === 'x64') return tripleForLinuxX64();
        if (platform === 'linux' && arch === 'arm64') return tripleForLinuxArm64();
        return null;
    })();
    if (!triple) {
        throw new Error(`invalid --target ${value}; expected win-x64, darwin-x64, darwin-arm64, linux-x64, or linux-arm64`);
    }
    return { platform, arch, triple };
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

async function sha256File(path) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
}

async function download(url, destination, expectedSha256) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    await mkdir(dirname(destination), { recursive: true });
    const partial = `${destination}.part`;
    await rm(partial, { force: true });
    try {
        await new Promise((resolveStream, rejectStream) => {
            const stream = createWriteStream(partial);
            Readable.fromWeb(response.body).pipe(stream);
            stream.on('finish', resolveStream);
            stream.on('error', rejectStream);
        });
        const actualSha256 = await sha256File(partial);
        if (actualSha256 !== expectedSha256) {
            throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`);
        }
        await rm(destination, { force: true });
        await rename(partial, destination);
    } catch (error) {
        await rm(partial, { force: true });
        throw error;
    }
}

function extract(archivePath, destDir) {
    return new Promise((resolveExtract, rejectExtract) => {
        const isZip = archivePath.toLowerCase().endsWith('.zip');
        const isWindowsTar = !isZip && process.platform === 'win32';
        const tarPath = 'C:\\Windows\\System32\\tar.exe';
        const command = isZip && process.platform === 'win32'
            ? 'powershell.exe'
            : isWindowsTar && existsSync(tarPath)
                ? tarPath
                : 'tar';
        const commandArgs = isZip && process.platform === 'win32'
            ? [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                'Expand-Archive',
                '-Path',
                archivePath,
                '-DestinationPath',
                destDir,
                '-Force'
            ]
            : ['-xzf', archivePath, '-C', destDir, ...(isWindowsTar && command === 'tar' ? ['--force-local'] : [])];
        const child = spawn(command, commandArgs, { stdio: 'inherit', shell: false });
        child.on('error', rejectExtract);
        child.on('close', code => code === 0 ? resolveExtract() : rejectExtract(new Error(`extractor exited with ${code}`)));
    });
}

async function fetchAndStage(target, version) {
    const url = archiveUrl(target, version);
    const expectedSha256 = NODE_SHA256[version]?.[target.triple];
    if (!expectedSha256) {
        throw new Error(`No pinned SHA-256 for Node ${version} ${target.triple}`);
    }
    const archiveExt = target.platform === 'win' ? '.zip' : '.tar.gz';
    const archive = join(tmpdir(), `node-${version}-${target.triple}${archiveExt}`);
    const stage = join(tmpdir(), `node-stage-${target.triple}`);

    console.log(`[node-bins] downloading ${url}`);
    await download(url, archive, expectedSha256);
    try {
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
        try {
            await rename(innerBin, outPath);
        } catch (err) {
            if (err.code === 'EXDEV') {
                // rename fails across drive letters on Windows; fall back to copy+delete
                await copyFile(innerBin, outPath);
                await unlink(innerBin);
            } else {
                throw err;
            }
        }
        const outputStat = await stat(outPath);
        if (!outputStat.isFile() || outputStat.size === 0) {
            throw new Error(`Node binary is missing or empty: ${outPath}`);
        }
        console.log(`[node-bins]   wrote ${outPath}`);
    } finally {
        await rm(archive, { force: true });
        await rm(stage, { recursive: true, force: true });
    }
}

const targets = targetArg
    ? [targetFromArg(targetArg)]
    : allTargets
        ? allTargetsList()
        : targetsForHost();
if (!targets.length) throw new Error('no Node targets selected');
await mkdir(outDir, { recursive: true });

await writeFile(join(outDir, 'README.md'), `# Bundled Node binaries

This directory is populated by:

\`\`\`bash
node scripts/download-node-binaries.mjs
\`\`\`

The Tauri desktop build expects a per-target \`node-\${triple}[.exe]\` directly
inside this directory. Pass \`--version=<version>\` to upgrade the bundled Node;
the version must have a pinned SHA-256 in this script.
`, 'utf8');

for (const target of targets) {
    await fetchAndStage(target, explicitVersion);
}

console.log(`[node-bins] done. wrote ${targets.length} binary(ies).`);
