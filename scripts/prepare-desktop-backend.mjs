// scripts/prepare-desktop-backend.mjs
//
// Stages a relocatable Python runtime + backend-py sources into
// frontend/desktop/src-tauri/resources/ so the Tauri installer can ship a
// working backend (no repo checkout required).
//
// Usage:
//   node scripts/prepare-desktop-backend.mjs              # dev: writes a "dev-placeholder" stamp
//   node scripts/prepare-desktop-backend.mjs --release    # release: writes the real sha256 stamp
//   node scripts/prepare-desktop-backend.mjs --skip-download   # reuse existing python/

import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rm, cp, access, writeFile, readFile, mkdtemp, rename, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
// Payload staging/hashing lives in scripts/desktop-backend-payload.mjs so tests
// can exercise it against a temporary fixture without downloading Python or
// building wheels. `prepare-desktop-backend.mjs` keeps only Python/wheels/stamp.
import {
  stageBackendPayload as _stageBackendPayload,
  hashStagedBackendPayload as _hashStagedBackendPayload,
} from './desktop-backend-payload.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = resolve(root, 'frontend/desktop/src-tauri/resources');
const pythonDir = join(resourcesDir, 'python');
const wheelsOut = join(resourcesDir, 'wheels');
const skipDownload = process.argv.includes('--skip-download');
// Release mode (real sha256 stamp) is opt-in via --release. A local dev
// prepare MUST write the "dev-placeholder" stamp instead: backend.rs treats
// that value as "no bundled stamp", so a dev checkout is never flipped into
// packaged mode (which would pin the AppData runtime to a stale snapshot).
const release = process.argv.includes('--release');

// On Windows, GNU tar (MSYS /usr/bin/tar) mishandles drive-letter paths like
// `C:\…`: it reads `C:` as a remote rsh host and fails with
// "Cannot connect to C: resolve failed". Prefer the System32 BSD tar
// (bsdtar) which understands native Windows paths natively. Fall back to
// GNU tar with --force-local only if the System32 binary is unavailable.
const SYSTEM32_TAR = 'C:\\Windows\\System32\\tar.exe';
function resolveTarBinary() {
  if (process.platform === 'win32' && existsSync(SYSTEM32_TAR)) {
    return { cmd: SYSTEM32_TAR, extraArgs: [] };
  }
  const extraArgs = process.platform === 'win32' ? ['--force-local'] : [];
  return { cmd: 'tar', extraArgs };
}

// python-build-standalone — relocatable CPython for Windows x64
const PYTHON_VERSION = '3.12.9';
const PYTHON_BUILD = '20250317';
const PYTHON_URL =
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/` +
  `cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-x86_64-pc-windows-msvc-install_only.tar.gz`;
const PYTHON_SHA256 = 'd15361fd202dd74ae9c3eece1abdab7655f1eba90bf6255cad1d7c53d463ed4d';
const BUILD_TOOLS_REQUIREMENTS = [
  'setuptools==81.0.0 \\',
  '    --hash=sha256:487b53915f52501f0a79ccfd0c02c165ffe06631443a886740b91af4b7a5845a \\',
  '    --hash=sha256:fdd925d5c5d9f62e4b74b30d6dd7828ce236fd6ed998a08d81de62ce5a6310d6',
  'wheel==0.48.0 \\',
  '    --hash=sha256:94800765601e9171bf5d58d066e640662842bcedcbab982b2c90787a2c987322 \\',
  '    --hash=sha256:3217dcc807155e45db462d7ef2431f5ddda0d7273b700d05a67b271ceb1287ab',
  'packaging==26.2 \\',
  '    --hash=sha256:5fc45236b9446107ff2415ce77c807cee2862cb6fac22b8a73826d0693b0980e \\',
  '    --hash=sha256:ff452ff5a3e828ce110190feff1178bb1f2ea2281fa2075aadb987c2fb221661',
].join('\n');

function quoteCmdArg(value) {
  return /[\s"^&|<>]/.test(value) ? `"${value}"` : value;
}

function resolveCommand(command, args) {
  if (process.platform !== 'win32' || command.includes('.')) {
    return { command, args };
  }
  const pathEntries = (process.env.PATH || '').split(';');
  for (const entry of pathEntries) {
    for (const suffix of ['.exe', '.cmd']) {
      const candidate = join(entry, `${command}${suffix}`);
      if (existsSync(candidate)) {
        if (suffix === '.cmd') {
          // cmd's /s strips the leading quote, which truncates a PATH entry
          // like C:\Program Files\nodejs\npm.cmd to 'C:\Program'.
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

function run(command, args, opts = {}) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    stdio: 'inherit',
    cwd: opts.cwd || root,
    env: { ...process.env, ...(opts.env || {}) },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

// Capture a short-lived command's stdout. Release callers fail closed when
// provenance is unavailable; development builds may report unknown.
function runCapture(command, args, cwd) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: cwd || root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  return result.status === 0 ? result.stdout || '' : '';
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function verifySha256(path, expected) {
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
}

async function download(url, dest, expectedSha256) {
  console.log(`[prepare-backend] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  await rm(partial, { force: true });
  try {
    await pipeline(res.body, createWriteStream(partial));
    await verifySha256(partial, expectedSha256);
    await rm(dest, { force: true });
    await rename(partial, dest);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  console.log(`[prepare-backend] saved ${dest}`);
}

async function extractTarGz(archive, dest) {
  await mkdir(dest, { recursive: true });
  const { cmd, extraArgs } = resolveTarBinary();
  run(cmd, [...extraArgs, '-xzf', archive, '-C', dest]);
}

async function hashTree(path) {
  const hash = createHash('sha256');
  async function visit(current) {
    const info = await stat(current);
    if (info.isDirectory()) {
      const children = (await readdir(current)).sort();
      for (const child of children) await visit(join(current, child));
      return;
    }
    if (!info.isFile() || current.endsWith('python.sha256')) return;
    const data = await readFile(current);
    hash.update(JSON.stringify([relative(pythonDir, current), data.length]) + '\n');
    hash.update(data);
  }
  await visit(path);
  return hash.digest('hex');
}

async function writePythonIntegrityMarker() {
  await writeFile(join(pythonDir, 'python.sha256'), `${await hashTree(pythonDir)}\n`);
}

async function verifyPythonIntegrity() {
  const markerPath = join(pythonDir, 'python.sha256');
  if (!(await pathExists(markerPath))) {
    throw new Error(`--skip-download requires an integrity marker at ${markerPath}; rebuild the runtime once without --skip-download`);
  }
  const expected = (await readFile(markerPath, 'utf8')).trim();
  const actual = await hashTree(pythonDir);
  if (!expected || actual !== expected) {
    throw new Error(`portable python integrity check failed (expected ${expected || 'marker'}, got ${actual})`);
  }
}

async function ensurePython() {
  const pythonExe = join(pythonDir, 'python.exe');
  const archive = join(resourcesDir, `cpython-${PYTHON_VERSION}-windows.tar.gz`);
  if (skipDownload && (await pathExists(pythonExe))) {
    try {
      await verifyPythonIntegrity();
      console.log('[prepare-backend] reusing verified portable python');
      return pythonExe;
    } catch (error) {
      if (!(await pathExists(archive))) throw error;
      console.warn(`[prepare-backend] ${error.message}; rebuilding from the pinned archive`);
    }
  }

  if (await pathExists(archive)) {
    await verifySha256(archive, PYTHON_SHA256);
  } else if (!skipDownload) {
    await download(PYTHON_URL, archive, PYTHON_SHA256);
  } else {
    throw new Error(`--skip-download requires ${archive} or a verified python/ tree`);
  }

  await rm(pythonDir, { recursive: true, force: true });
  await mkdir(pythonDir, { recursive: true });

  const extractTmp = join(resourcesDir, '_python_extract');
  await rm(extractTmp, { recursive: true, force: true });
  await mkdir(extractTmp, { recursive: true });
  await extractTarGz(archive, extractTmp);

  // install_only layout: extractTmp/python/...
  const extractedPython = join(extractTmp, 'python');
  if (!(await pathExists(join(extractedPython, 'python.exe')))) {
    throw new Error(`expected ${extractedPython}/python.exe after extract`);
  }
  await cp(extractedPython, pythonDir, { recursive: true });
  await rm(extractTmp, { recursive: true, force: true });

  // Drop the large archive from resources (keep only the runtime)
  await rm(archive, { force: true });

  if (!(await pathExists(pythonExe))) {
    throw new Error('portable python.exe missing after extract');
  }
  await writePythonIntegrityMarker();
  console.log(`[prepare-backend] portable python ready: ${pythonExe}`);
  return pythonExe;
}

async function stageBackendSources() {
  // Delegates to scripts/desktop-backend-payload.mjs:
  //   - stages backend-py app/sidecar/pyproject/README into resources/backend-py
  //   - runs a deterministic `npm ci --omit=dev --ignore-scripts` INSIDE the
  //     staged sidecar (never reuses the developer node_modules, which the
  //     exclusion filter leaves out of the payload anyway)
  //   - stages bundled skills → resources/skills (D16): installed builds resolve
  //     SKILLS_DIR to {appData}/backend-runtime/skills; without this, packaged
  //     apps ship ZERO built-in skills
  await _stageBackendPayload(root, resourcesDir);
  console.log(`[prepare-backend] staged backend sources → ${join(resourcesDir, 'backend-py')}`);
  console.log('[prepare-backend] sidecar deps installed (npm ci, production, deterministic lockfile)');
  console.log(`[prepare-backend] staged bundled skills → ${join(resourcesDir, 'skills')}`);
}

async function buildWheels(pythonExe) {
  await rm(wheelsOut, { recursive: true, force: true });
  await mkdir(wheelsOut, { recursive: true });

  const backendSource = resolve(root, 'backend-py');
  const buildTmp = await mkdtemp(join(tmpdir(), 'august-backend-wheels-'));
  const isolatedBackend = join(buildTmp, 'backend-py');
  const requirementsPath = join(buildTmp, 'requirements.txt');
  const buildToolsRequirementsPath = join(buildTmp, 'build-tools-requirements.txt');
  const buildVenv = join(buildTmp, 'build-venv');
  const buildPython = process.platform === 'win32'
    ? join(buildVenv, 'Scripts/python.exe')
    : join(buildVenv, 'bin/python');

  try {
    // Copy the project before invoking setuptools so build metadata cannot
    // mutate the developer checkout (egg-info, build/, or dist/).
    await cp(backendSource, isolatedBackend, {
      recursive: true,
      filter: (path) => {
        const name = path.split(/[\\/]/).at(-1);
        return !['build', 'dist', 'august_proxy.egg-info', '.venv', '__pycache__', '.mypy_cache', '.ruff_cache', '.pytest_cache'].includes(name);
      },
    });

    // Export the locked runtime graph, including hashes and platform markers.
    run('uv', [
      'export',
      '--frozen',
      '--no-dev',
      '--no-emit-project',
      '--format',
      'requirements-txt',
      '--output-file',
      requirementsPath,
    ], { cwd: backendSource });

    // Build only wheels from the locked graph. --only-binary fails closed if a
    // source build would introduce an unverified build dependency.
    run(pythonExe, [
      '-m', 'pip', 'wheel',
      '--wheel-dir', wheelsOut,
      '--require-hashes',
      '--only-binary=:all:',
      '--requirement', requirementsPath,
      '--disable-pip-version-check',
    ], {
      env: {
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    });

    // Build the August project wheel in an isolated, pinned build environment.
    // The project is intentionally built separately because --no-emit-project
    // keeps it out of the runtime requirements export.
    run(pythonExe, ['-m', 'venv', buildVenv]);
    await writeFile(buildToolsRequirementsPath, `${BUILD_TOOLS_REQUIREMENTS}\n`);
    run(buildPython, [
      '-m', 'pip', 'install',
      '--require-hashes',
      '--only-binary=:all:',
      '--requirement', buildToolsRequirementsPath,
      '--disable-pip-version-check',
    ]);
    run(buildPython, [
      '-m', 'pip', 'wheel',
      '--no-deps',
      '--no-build-isolation',
      '--wheel-dir', wheelsOut,
      isolatedBackend,
    ]);

    const wheelNames = await readdir(wheelsOut);
    if (!wheelNames.some((name) => name.startsWith('august_proxy-') && name.endsWith('.whl'))) {
      throw new Error('backend project wheel was not produced');
    }
    console.log(`[prepare-backend] wheels → ${wheelsOut}`);
  } finally {
    await rm(buildTmp, { recursive: true, force: true });
  }
}

async function writeManifest(pythonExe) {
  // Which commit this staged backend came from. The installed app runs the
  // AppData copy, not the checkout, so without this line nothing on the
  // running side identifies its own source — a prompt sentence that exists in
  // no checkout can only be chased down by archaeology (audit finding
  // 2026-09-15 #7). diagnose_proxy reports it as `Runtime code:`.
  // Empty when git is unavailable (source-tarball build); the runtime then
  // honestly reports "unknown" rather than a wrong SHA.
  const sourceSha = runCapture('git', ['rev-parse', '--short', 'HEAD'], root).trim();
  const sourceBranch = runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
  const sourceDirty = runCapture('git', ['status', '--porcelain'], root).trim() !== '';
  if (release && (!sourceSha || !sourceBranch)) {
    throw new Error('release runtime manifest requires Git source provenance');
  }
  // The app version travels with the staged backend so an installed build
  // reports its real version instead of the 0.1.0 fallback.
  let appVersion = '';
  try {
    appVersion = String(JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version || '');
  } catch {
    /* unreadable package.json — the backend keeps its fallback */
  }
  const manifest = {
    pythonVersion: PYTHON_VERSION,
    pythonBuild: PYTHON_BUILD,
    preparedAt: new Date().toISOString(),
    pythonExe: 'python/python.exe',
    backendPath: 'backend-py',
    wheelsPath: 'wheels',
    appVersion,
    sourceSha,
    sourceBranch,
    sourceDirty,
  };
  await writeFile(join(resourcesDir, 'backend-runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (release) {
    // Real runtime stamp the Rust side can hash for rebuild detection. The
    // payload hash covers every staged runtime root (backend, skills, wheels,
    // portable Python, and canonical manifest data), including the npm
    // ci-installed sidecar dependencies. Local caches, tests, and mtimes cannot
    // move it, while any shipped-bit change does.
    const hash = createHash('sha256');
    hash.update(PYTHON_VERSION);
    hash.update(PYTHON_BUILD);
    hash.update(await _hashStagedBackendPayload(resourcesDir));
    try {
      const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
      hash.update(String(pkg.version || ''));
    } catch { /* ignore */ }
    await writeFile(join(resourcesDir, 'backend-runtime.stamp'), `${hash.digest('hex')}\n`);
    console.log('[prepare-backend] release mode — real runtime stamp written');
  } else {
    // Dev mode: keep the dev checkout out of "packaged" mode. backend.rs
    // bundledStamp() filters "dev-placeholder" out, so the desktop app keeps
    // using repo sources instead of the staged AppData runtime.
    await writeFile(join(resourcesDir, 'backend-runtime.stamp'), 'dev-placeholder\n');
    console.log('[prepare-backend] dev mode — wrote dev-placeholder stamp');
  }
  console.log(`[prepare-backend] manifest written (python=${pythonExe})`);
}

async function main() {
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(
    join(resourcesDir, 'README.md'),
    [
      '# Desktop backend resources',
      '',
      'Generated by `node scripts/prepare-desktop-backend.mjs`.',
      'Do not commit the python/ / backend-py/ / wheels/ trees — CI/release builds them.',
      '',
    ].join('\n'),
  );

  const pythonExe = await ensurePython();
  await stageBackendSources();
  await buildWheels(pythonExe);
  await writeManifest(pythonExe);
  console.log('[prepare-backend] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
