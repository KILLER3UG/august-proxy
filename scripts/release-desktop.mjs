// scripts/release-desktop.mjs
//
// Builds the desktop release assets. `latest.json` is the Tauri updater feed;
// `august-desktop-manifest.json` is legacy web checksum metadata.
//
// Usage:
//   node scripts/release-desktop.mjs patch
//   node scripts/release-desktop.mjs minor
//   node scripts/release-desktop.mjs --version=0.18.12 --tauri --publish
//   node scripts/release-desktop.mjs patch --dry-run
//
// The script builds the web UI, stages backend code and node_modules, zips web
// and backend assets, computes checksums, writes the release manifest, and
// optionally publishes an explicit asset allowlist to GitHub Releases.

import { mkdir, writeFile, readFile, rm, readdir, stat, rename } from 'node:fs/promises';
import { existsSync, createReadStream, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = resolve(root, 'releases/desktop');
const webDist = resolve(root, 'web-dist');
const backendDir = resolve(root, 'backend');
const nodeModules = resolve(root, 'node_modules');
const packageJsonPath = resolve(root, 'package.json');
const manifestPath = join(releaseDir, 'august-desktop-manifest.json');
const latestPath = join(releaseDir, 'latest.json');
const tauriBundleDir = resolve(root, 'frontend/desktop/src-tauri/target/release/bundle');
const repository = process.env.GITHUB_REPOSITORY || 'KILLER3UG/august-proxy';

const rawArgs = process.argv.slice(2);
const knownFlags = new Set(['--publish', '--tauri', '--dry-run', '--draft']);
let versionArg = null;
let bumpArg = null;
const flags = new Set();
for (const arg of rawArgs) {
    if (arg === 'patch' || arg === 'minor' || arg === 'major') {
        if (bumpArg) throw new Error(`multiple bump selectors: ${bumpArg}, ${arg}`);
        bumpArg = arg;
        continue;
    }
    if (arg.startsWith('--version=')) {
        if (versionArg !== null) throw new Error('multiple --version selectors');
        versionArg = arg.slice('--version='.length);
        continue;
    }
    if (arg === '--version') throw new Error('--version requires a value using --version=<semver>');
    if (knownFlags.has(arg)) {
        flags.add(arg);
        continue;
    }
    throw new Error(`unknown release argument: ${arg}`);
}
if (versionArg !== null && bumpArg) {
    throw new Error('choose either --version=<semver> or a bump selector, not both');
}

const publish = flags.has('--publish');
const buildTauri = flags.has('--tauri');
const dryRun = flags.has('--dry-run');
const draft = flags.has('--draft');
const currentVersion = await readVersion();
const version = normalizeVersion(
    versionArg !== null
        ? versionArg
        : (bumpArg ? bumpVersion(currentVersion, bumpArg) : currentVersion),
);

function normalizeVersion(value) {
    const normalized = String(value).trim().replace(/^v(?=\d)/i, '');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)) {
        throw new Error(`invalid release version: ${value}`);
    }
    return normalized;
}

function bumpVersion(current, bump) {
    const normalized = normalizeVersion(current);
    const parts = normalized.split('.').slice(0, 3).map(Number);
    if (bump === 'major') return [parts[0] + 1, 0, 0].join('.');
    if (bump === 'minor') return [parts[0], parts[1] + 1, 0].join('.');
    return [parts[0], parts[1], parts[2] + 1].join('.');
}

async function readVersion() {
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    return normalizeVersion(pkg.version);
}

function quoteCmdArg(value) {
    return /[\s"^&|<>]/.test(value) ? `"${value}"` : value;
}

function resolveCommand(command, args) {
    if (process.platform !== 'win32' || command.includes('.')) {
        return { command, args };
    }
    const pathEntries = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
    for (const entry of pathEntries) {
        for (const suffix of ['.exe', '.cmd']) {
            const candidate = join(entry, `${command}${suffix}`);
            if (existsSync(candidate)) {
                if (suffix === '.cmd') {
                    // cmd's /s strips the leading quote, which truncates a PATH entry
                    // like C:\Program Files\nodejs\npm.cmd to 'C:\Program'. Pass one
                    // verbatim command line with the program quoted instead.
                    return {
                        command: process.env.ComSpec || 'cmd.exe',
                        args: ['/d', '/c', [`"${candidate}"`, ...args.map(quoteCmdArg)].join(' ')],
                        verbatimArguments: true,
                    };
                }
                return { command: candidate, args };
            }
        }
    }
    return { command, args };
}

function run(command, args, options = {}) {
    const resolved = resolveCommand(command, args);
    const result = spawnSync(resolved.command, resolved.args, {
        stdio: 'inherit',
        cwd: options.cwd || root,
        env: { ...process.env, ...(options.env || {}) },
        shell: false,
        ...(resolved.verbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const exit = result.signal || result.status || 'unknown';
        throw new Error(`${command} ${args.join(' ')} exited with ${exit}`);
    }
}

function runCapture(command, args, cwd) {
    const resolved = resolveCommand(command, args);
    const result = spawnSync(resolved.command, resolved.args, {
        cwd: cwd || root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        ...(resolved.verbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    return result.status === 0 ? result.stdout || '' : '';
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

async function assertNonEmptyFile(path) {
    let info;
    try {
        info = await stat(path);
    } catch {
        throw new Error(`release file is missing: ${path}`);
    }
    if (!info.isFile() || info.size === 0) {
        throw new Error(`release file is empty or not a regular file: ${path}`);
    }
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
    // Legacy Node sidecar zip — only when the old `backend/` tree still exists.
    // Current desktop releases ship the Tauri installers + Python tree separately.
    if (!existsSync(backendDir)) {
        console.log('[release] skipping legacy Node backend zip (backend/ not present)');
        return false;
    }
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
    if (Test-Path -LiteralPath \$nodeModules) {
        Add-Directory \$nodeModules 'backend/node_modules'
    }
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
    return true;
}

function publicUrl(filename, releaseVersion = version) {
    return `https://github.com/${repository}/releases/download/v${releaseVersion}/${filename}`;
}

async function buildWeb() {
    run('npm', ['run', 'build:web']);
}

async function checkVersionSources() {
    run('node', ['scripts/check-version-sync.mjs']);
}

async function syncPackageVersions(nextVersion) {
    await checkVersionSources();

    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    pkg.version = nextVersion;
    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const desktopPkgPath = resolve(root, 'frontend/desktop/package.json');
    const desktopPkg = JSON.parse(await readFile(desktopPkgPath, 'utf8'));
    desktopPkg.version = nextVersion;
    await writeFile(desktopPkgPath, `${JSON.stringify(desktopPkg, null, 2)}\n`);

    const tauriConfPath = resolve(root, 'frontend/desktop/src-tauri/tauri.conf.json');
    const conf = JSON.parse(await readFile(tauriConfPath, 'utf8'));
    conf.version = nextVersion;
    await writeFile(tauriConfPath, `${JSON.stringify(conf, null, 2)}\n`);

    const cargoPath = resolve(root, 'frontend/desktop/src-tauri/Cargo.toml');
    let cargo = await readFile(cargoPath, 'utf8');
    const cargoUpdated = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
    if (cargoUpdated === cargo) throw new Error('could not update august-desktop crate version');
    await writeFile(cargoPath, cargoUpdated);

    const lockPath = resolve(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.version = nextVersion;
    if (lock.packages?.['']) lock.packages[''].version = nextVersion;
    if (lock.packages?.['frontend/desktop']) lock.packages['frontend/desktop'].version = nextVersion;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const cargoLockPath = resolve(root, 'frontend/desktop/src-tauri/Cargo.lock');
    let cargoLock = await readFile(cargoLockPath, 'utf8');
    const cargoLockUpdated = cargoLock.replace(
        /(^name = "august-desktop"[\s\S]*?^version = ")[^"]+(")/m,
        `$1${nextVersion}$2`,
    );
    if (cargoLockUpdated === cargoLock) throw new Error('could not update august-desktop Cargo.lock version');
    await writeFile(cargoLockPath, cargoLockUpdated);

    await checkVersionSources();
    console.log(`[release] synced package versions to ${nextVersion}`);
}

function exactNsisArtifact(nextVersion) {
    const dir = join(tauriBundleDir, 'nsis');
    const expected = `August_${nextVersion}_x64-setup.exe`;
    if (!existsSync(dir)) throw new Error(`Tauri NSIS bundle directory is missing: ${dir}`);
    const matches = readdirSync(dir).filter((name) => name === expected);
    if (matches.length !== 1) {
        throw new Error(`expected exactly one ${expected}, found ${matches.length}`);
    }
    const path = join(dir, expected);
    const sigPath = `${path}.sig`;
    if (!existsSync(sigPath)) throw new Error(`signed NSIS artifact is missing: ${sigPath}`);
    return { artifact: expected, path, sigPath };
}

function exactMsiArtifact(nextVersion) {
    const dir = join(tauriBundleDir, 'msi');
    const expected = `August_${nextVersion}_x64_en-US.msi`;
    if (!existsSync(dir)) throw new Error(`Tauri MSI bundle directory is missing: ${dir}`);
    const matches = readdirSync(dir).filter((name) => name === expected);
    if (matches.length !== 1) {
        throw new Error(`expected exactly one ${expected}, found ${matches.length}`);
    }
    const path = join(dir, expected);
    const sigPath = `${path}.sig`;
    if (!existsSync(sigPath)) throw new Error(`signed MSI artifact is missing: ${sigPath}`);
    return { artifact: expected, path, sigPath };
}

export async function readUpdaterSignature(signaturePath) {
    const signature = (await readFile(signaturePath, 'utf8')).trim();
    if (!signature) throw new Error(`Updater signature is empty: ${signaturePath}`);
    return signature;
}

async function validateLatestManifest(path, nextVersion, nsis) {
    await assertNonEmptyFile(path);
    const latest = JSON.parse(await readFile(path, 'utf8'));
    if (latest.version !== nextVersion) {
        throw new Error(`updater manifest version ${latest.version} does not match ${nextVersion}`);
    }
    const platform = latest.platforms?.['windows-x86_64'];
    if (!platform) throw new Error('updater manifest has no windows-x86_64 platform');
    const expectedUrl = publicUrl(nsis.artifact, nextVersion);
    if (platform.url !== expectedUrl) {
        throw new Error(`updater manifest URL ${platform.url} does not match ${expectedUrl}`);
    }
    const expectedSignature = await readUpdaterSignature(nsis.sigPath);
    if (platform.signature !== expectedSignature) {
        throw new Error('updater manifest signature does not match the base64-encoded NSIS signature file');
    }
}

async function buildLatestJsonFromSignatures(nextVersion) {
    const nsis = exactNsisArtifact(nextVersion);
    const signature = await readUpdaterSignature(nsis.sigPath);
    const latest = {
        version: nextVersion,
        notes: `August desktop ${nextVersion}`,
        pub_date: new Date().toISOString(),
        platforms: {
            'windows-x86_64': {
                signature,
                url: publicUrl(nsis.artifact, nextVersion),
            },
        },
    };
    await mkdir(releaseDir, { recursive: true });
    await writeFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
    await validateLatestManifest(latestPath, nextVersion, nsis);
    console.log(`[release] generated updater manifest ${latestPath} → ${nsis.artifact}`);
    return latestPath;
}

async function prepareTauriUpdaterManifest(nextVersion) {
    return buildLatestJsonFromSignatures(nextVersion);
}

async function cleanTauriBundle() {
    const backupDir = join(tauriBundleDir, '.prev');
    const moved = [];
    await rm(backupDir, { recursive: true, force: true });
    for (const sub of ['msi', 'nsis']) {
        const dir = join(tauriBundleDir, sub);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
            if (name === 'latest.json' || name.endsWith('.msi') || name.endsWith('.exe') || name.endsWith('.sig')) {
                const from = join(dir, name);
                const to = join(backupDir, sub, name);
                await mkdir(join(backupDir, sub), { recursive: true });
                await rename(from, to);
                moved.push({ from, to });
            }
        }
    }
    // Nothing under releases/ is version controlled, so a build that fails
    // halfway must not be left holding neither a new nor a last-good signed
    // installer pair — restore() puts the previous release back on failure.
    return {
        async restore() {
            for (const { from, to } of moved) {
                if (!existsSync(to)) continue;
                await mkdir(dirname(from), { recursive: true });
                await rename(to, from).catch(() => {});
            }
        },
        async discard() {
            await rm(backupDir, { recursive: true, force: true });
        },
    };
}

async function cleanReleaseOutputs() {
    await mkdir(releaseDir, { recursive: true });
    for (const name of await readdir(releaseDir)) {
        if (/^(web|backend)-.*\.zip$/.test(name)) {
            await rm(join(releaseDir, name), { force: true });
        }
    }
    await rm(manifestPath, { force: true });
    // Only a --tauri run regenerates the updater manifest. Without the flag
    // deleting it here would take the published updater offline for nothing.
    if (buildTauri) await rm(latestPath, { force: true });
}

// PowerShell deletes an env var assigned an empty string, so a wrapper cannot
// hand Tauri the key's empty password; setting it deleted is exactly what makes
// `tauri build` block on an interactive prompt. Apply it here instead.
function signingEnv() {
    if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined) return {};
    return { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
}

async function buildTauriApp() {
    if (!buildTauri) return;
    const backup = await cleanTauriBundle();
    try {
        run('npm', ['run', 'download:node-binaries']);
        run('node', ['scripts/prepare-desktop-backend.mjs', '--release']);
        run('npm', ['run', 'tauri', '-w', 'frontend/desktop', 'build'], { env: signingEnv() });
        const generated = await prepareTauriUpdaterManifest(version);
        await assertNonEmptyFile(generated);
    } catch (error) {
        await backup.restore();
        console.error('[release] build failed — restored the previous signed installer pair');
        throw error;
    }
    await backup.discard();
}

async function releaseAssets({ webZip, backendZip, didBackendZip }) {
    const assets = [webZip];
    if (didBackendZip) assets.push(backendZip);
    assets.push(manifestPath, latestPath);

    const nsis = exactNsisArtifact(version);
    assets.push(nsis.path, nsis.sigPath);

    const msi = exactMsiArtifact(version);
    assets.push(msi.path, msi.sigPath);

    for (const path of assets) await assertNonEmptyFile(path);
    return assets;
}

function gh(args, capture = false) {
    const resolved = resolveCommand('gh', args);
    const result = spawnSync(resolved.command, resolved.args, {
        cwd: root,
        encoding: 'utf8',
        shell: false,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: process.env,
        ...(resolved.verbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = capture
            ? `${result.stdout || ''}${result.stderr || ''}`.trim()
            : `exit ${result.signal || result.status || 'unknown'}`;
        throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
    }
    return capture ? { stdout: result.stdout || '', stderr: result.stderr || '' } : null;
}

function currentCommit() {
    const commit = runCapture('git', ['rev-parse', 'HEAD'], root).trim();
    if (!commit) throw new Error('could not determine the current commit');
    return commit;
}

function releaseTagCommit(tag) {
    const ref = gh(['api', `repos/${repository}/git/ref/tags/${tag}`], true);
    let releaseRef;
    try {
        releaseRef = JSON.parse(ref.stdout);
    } catch (error) {
        throw new Error(`could not parse GitHub tag response for ${tag}: ${error.message}`);
    }
    let object = releaseRef.object;
    if (!object || typeof object.sha !== 'string') {
        throw new Error(`GitHub tag ${tag} has no object`);
    }
    if (object.type === 'tag') {
        const tagObject = gh(['api', `repos/${repository}/git/tag/${object.sha}`], true);
        try {
            object = JSON.parse(tagObject.stdout).object;
        } catch (error) {
            throw new Error(`could not parse annotated tag ${tag}: ${error.message}`);
        }
    }
    if (!object || typeof object.sha !== 'string') {
        throw new Error(`GitHub tag ${tag} does not resolve to a commit`);
    }
    return object.sha;
}

function assertReleaseTagMatchesCurrentCommit(tag) {
    const expected = currentCommit();
    const actual = releaseTagCommit(tag);
    if (actual !== expected) {
        throw new Error(`release tag ${tag} points to ${actual}, not current commit ${expected}`);
    }
}

function releaseTagCommitIfExists(tag) {
    try {
        return releaseTagCommit(tag);
    } catch (error) {
        if (/not found|404/i.test(error.message)) return null;
        throw error;
    }
}

async function publishRelease(assets) {
    if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required for --publish');
    if (!assets.length) throw new Error('release asset list is empty');
    const tag = `v${version}`;
    const expectedCommit = currentCommit();
    const tagCommit = releaseTagCommitIfExists(tag);
    if (tagCommit && tagCommit !== expectedCommit) {
        throw new Error(`release tag ${tag} points to ${tagCommit}, not current commit ${expectedCommit}`);
    }

    let releaseExists = false;
    try {
        gh(['release', 'view', tag, '--repo', repository], true);
        releaseExists = true;
    } catch (error) {
        if (!/not found|404/i.test(error.message)) throw error;
    }

    if (releaseExists) {
        run('gh', ['release', 'upload', tag, '--clobber', '--repo', repository, ...assets], { shell: false });
    } else {
        const title = `August ${version}`;
        const notes = `August desktop release ${version}`;
        run('gh', [
            'release',
            'create',
            tag,
            '--title',
            title,
            '--notes',
            notes,
            '--repo',
            repository,
            ...(draft ? ['--draft'] : []),
            ...assets,
        ], { shell: false });
    }
    console.log(`[release] published GitHub release ${tag}`);
}

async function main() {
    if (dryRun) {
        console.log('[release] DRY RUN — no files will be modified, no builds executed.\n');
        console.log(`  Version:        ${version}${bumpArg ? ` (${bumpArg} bump from ${currentVersion})` : ''}`);
        console.log(`  Publish:        ${publish ? 'yes (explicit asset allowlist)' : 'no'}`);
        console.log(`  Tauri build:    ${buildTauri ? 'yes' : 'no'}`);
        console.log(`  Release dir:    ${releaseDir}`);
        console.log(`  Web zip:        ${join(releaseDir, `web-${version}.zip`)}`);
        console.log(`  Manifest:       ${manifestPath}`);
        console.log(`  Updater:        ${latestPath}`);
        console.log('\n[release] DRY RUN complete. Remove --dry-run to execute.');
        return;
    }

    if ((versionArg !== null && versionArg !== currentVersion) || bumpArg) await syncPackageVersions(version);
    await cleanReleaseOutputs();

    const webZip = join(releaseDir, `web-${version}.zip`);
    const backendZip = join(releaseDir, `backend-${version}.zip`);

    await buildWeb();
    await buildTauriApp();
    const didBackendZip = await zipBackend(backendZip);
    await zipFolder(webDist, webZip);

    const webSha = await sha256(webZip);
    const manifest = {
        version,
        web: {
            url: publicUrl(`web-${version}.zip`),
            sha256: webSha,
            path: 'web'
        },
    };
    if (didBackendZip && existsSync(backendZip)) {
        manifest.backend = {
            url: publicUrl(`backend-${version}.zip`),
            sha256: await sha256(backendZip),
            path: 'backend'
        };
    }

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // Only a --tauri run produces the updater manifest, so only that run can
    // be expected to have one.
    if (buildTauri) await assertNonEmptyFile(latestPath);

    console.log(`[release] version ${version}`);
    console.log(`[release] web ${webZip}`);
    if (didBackendZip) console.log(`[release] backend ${backendZip}`);
    console.log(`[release] manifest ${manifestPath}`);

    if (publish) {
        const assets = await releaseAssets({ webZip, backendZip, didBackendZip });
        await publishRelease(assets);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
