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

import { createReadStream, readFileSync } from 'node:fs';
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

// ngspice — the SPICE engine the circuit workbench drives. Nothing used to
// stage it: `resources/ngspice/**` is gitignored and no script fetched it, so a
// clean release build silently shipped without a simulator while the docs said
// it did. Pinned by SHA-256 from the project's own win64 archive.
const NGSPICE_VERSION = '45.2';
const NGSPICE_ARCHIVE = `ngspice-${NGSPICE_VERSION}_64.7z`;
const NGSPICE_URL =
  `https://sourceforge.net/projects/ngspice/files/ng-spice-rework/old-releases/` +
  `${NGSPICE_VERSION}/${NGSPICE_ARCHIVE}/download`;
const NGSPICE_SHA256 =
  '6a0c44056e7f2aae9bd6b3f5a74d1846fcf1e5d4470b01a89429629cfd0a0942';
// Bumped whenever the staged LAYOUT changes, not just the archive: a marker
// holding only the source hash would let a tree staged without lib/ngspice
// claim it was already correct and skip the fix forever.
const NGSPICE_LAYOUT_REVISION = 'r2-codemodels';
const NGSPICE_MARKER = `${NGSPICE_SHA256} ${NGSPICE_LAYOUT_REVISION}`;
const ngspiceDir = join(resourcesDir, 'ngspice');
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

// AGENTS.md documents `uv run pytest`, but uv is not guaranteed to be on the
// PATH of the shell that runs a release — a venv-local install is invisible
// there. Look in the project venv first, then PATH.
function resolveUv() {
  const venvUv = process.platform === 'win32'
    ? join(root, 'backend-py', '.venv', 'Scripts', 'uv.exe')
    : join(root, 'backend-py', '.venv', 'bin', 'uv');
  if (existsSync(venvUv)) return venvUv;
  const probed = resolveCommand('uv', []);
  if (probed.command !== 'uv' && existsSync(probed.command)) return probed.command;
  throw new Error(
    `uv is required to export the locked dependency graph from backend-py/uv.lock ` +
      `but was not found (looked at ${venvUv} and PATH). Install it, or run ` +
      '`backend-py/.venv/Scripts/python.exe -m pip install uv`.',
  );
}

function run(command, args, opts = {}) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    stdio: opts.stdio || 'inherit',
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
    // Read the whole body before touching disk. Piping `res.body` into a
    // writeStream throws an *uncatchable* ERR_ASSERTION (`assert(!this.paused)`)
    // on SourceForge's mirror redirect under Node 24, which kills the process
    // mid-release instead of failing the step. These archives are tens of MB.
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new Error(`download returned 0 bytes: ${url}`);
    await writeFile(partial, bytes);
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

function resolveSevenZip() {
  for (const candidate of ['7z', '7za', '7zr']) {
    const resolved = resolveCommand(candidate, []);
    // resolveCommand hands back the bare name when PATH has nothing, so probe
    // for the real file rather than trusting a pass-through.
    if (resolved.command !== candidate && existsSync(resolved.command)) return resolved.command;
  }
  throw new Error(
    'staging ngspice needs a 7z-capable extractor (7z, 7za or 7zr) on PATH. ' +
      'bsdtar is deliberately not used as a fallback: on this archive it reports ' +
      '"Archive entry has empty or unreadable filename", skips ~20 entries and ' +
      'still exits successfully, which would bundle an engine missing the DLLs ' +
      'it imports.'
  );
}

/** The engine is only usable if it can load its own code models: ngspice
 *  resolves `../lib/ngspice/*.cm` relative to the executable and spinit sources
 *  them at startup. Without analog.cm an `.ac` run never solves; without
 *  digital.cm every XSPICE part the gate workbench needs is dead. `--version`
 *  reports neither, so the guard is file existence plus a real `.ac` solve
 *  through the staged binary in its final layout. */
async function verifyNgspiceRuns(exe, version) {
  const started = spawnSync(exe, ['--version'], { encoding: 'utf8', shell: false });
  const banner = `${started.stdout || ''}${started.stderr || ''}`;
  if (started.error || !banner.includes(`ngspice-${version}`)) {
    throw new Error(
      `staged ngspice did not report v${version}: ` +
        `${banner.trim().slice(0, 200) || started.error?.message || 'no output'}`
    );
  }

  const probe = await mkdtemp(join(tmpdir(), 'august-ngspice-probe-'));
  try {
    await writeFile(join(probe, 'smoke.cir'), [
      '* staging smoke test',
      'Vin in 0 5',
      'R1 in out 1k',
      'C1 out 0 1u',
      '.ac dec 10 1 1meg',
      '.print ac v(out)',
      '.end',
      '',
    ].join('\n'));
    const run = spawnSync(exe, ['-b', '-o', 'smoke.out', 'smoke.cir'], {
      cwd: probe, encoding: 'utf8', shell: false,
    });
    if (run.error) throw new Error(`staged ngspice could not start: ${run.error.message}`);
    const log = existsSync(join(probe, 'smoke.out'))
      ? readFileSync(join(probe, 'smoke.out'), 'utf8')
      : '';
    // Positive proof of a solved sweep: ngspice prints the row count and then a
    // `frequency v(out)` table. Asserting this rather than scanning for error
    // wording, which differs between builds.
    const rows = /No\. of Data Rows\s*:\s*(\d+)/i.exec(log);
    if (run.status !== 0 || !rows || Number(rows[1]) < 2 || !/frequency/i.test(log)) {
      throw new Error(
        `staged ngspice produced no .ac solution (exit ${run.status}, rows ` +
        `${rows ? rows[1] : 'none'}); this bundle is not usable:\n` +
        `${log.split('\n').filter(Boolean).slice(0, 8).join('\n')}`
      );
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

/** Stage the pinned win64 ngspice into resources so the installer carries a
 *  working engine. Only the console binary ships: the GUI `ngspice.exe` never
 *  emits stdout through a pipe, so the backend cannot drive it. */
async function ensureNgspice() {
  if (process.platform !== 'win32') {
    console.warn('[prepare-backend] ngspice staging is win64-only; skipping');
    return;
  }
  const markerPath = join(ngspiceDir, 'staged-from.sha256');
  const stagedToken = existsSync(markerPath)
    ? (await readFile(markerPath, 'utf8')).trim()
    : null;
  if (skipDownload) {
    if (stagedToken !== NGSPICE_MARKER) {
      throw new Error(
        `--skip-download refuses ${ngspiceDir}: staged marker is ` +
        `${stagedToken === null ? 'absent' : `${stagedToken}`}, not ${NGSPICE_MARKER}. ` +
        'Run once without --skip-download to restage.',
      );
    }
    console.log('[prepare-backend] reusing staged ngspice (--skip-download)');
    return;
  }
  if (stagedToken === NGSPICE_MARKER) {
    console.log(`[prepare-backend] ngspice ${NGSPICE_VERSION} already staged`);
    return;
  }

  const staging = await mkdtemp(join(tmpdir(), 'august-ngspice-'));
  try {
    const archive = join(staging, NGSPICE_ARCHIVE);
    await download(NGSPICE_URL, archive, NGSPICE_SHA256);
    const extracted = join(staging, 'extracted');
    await mkdir(extracted, { recursive: true });
    run(resolveSevenZip(), ['x', archive, `-o${extracted}`, '-y'], { stdio: 'ignore' });

    const source = join(extracted, 'Spice64');
    for (const rel of [
      'bin/ngspice_con.exe',
      'bin/libomp140.x86_64.dll',
      'share/ngspice',
      'lib/ngspice/analog.cm',
      'lib/ngspice/digital.cm',
      'lib/ngspice/spice2poly.cm',
    ]) {
      if (!existsSync(join(source, ...rel.split('/')))) {
        // Fail loudly: a partial tree that still contains the exe would pass a
        // naive existence check and crash on the user's first simulation.
        throw new Error(`ngspice archive is missing ${rel}`);
      }
    }

    const staged = join(staging, 'ngspice');
    await mkdir(join(staged, 'bin'), { recursive: true });
    await cp(join(source, 'bin', 'ngspice_con.exe'), join(staged, 'bin', 'ngspice_con.exe'));
    await cp(join(source, 'bin', 'libomp140.x86_64.dll'), join(staged, 'bin', 'libomp140.x86_64.dll'));
    await cp(join(source, 'share', 'ngspice'), join(staged, 'share', 'ngspice'), { recursive: true });
    // The code models live next to `../lib/ngspice` from the executable's view;
    // leaving them out silently kills .ac/.tran solves and all XSPICE parts.
    await cp(join(source, 'lib', 'ngspice'), join(staged, 'lib', 'ngspice'), { recursive: true });
    await cp(join(source, 'docs', 'COPYING'), join(staged, 'LICENSE'));
    await writeFile(
      join(staged, 'README.md'),
      [
        `# Bundled ngspice (${NGSPICE_VERSION}, win64)`,
        '',
        'Generated by `node scripts/prepare-desktop-backend.mjs` — do not edit by',
        'hand and do not commit (`resources/ngspice/**` is gitignored). The tree',
        'comes from the single archive pinned as `NGSPICE_URL` below, verified',
        'against `NGSPICE_SHA256`, and the staged binary is executed with',
        '`--version` before it is accepted.',
        '',
        '- Source: https://sourceforge.net/projects/ngspice/files/',
        `          ng-spice-rework/old-releases/${NGSPICE_VERSION}/${NGSPICE_ARCHIVE}`,
        '- License: Modified BSD, copied from the archive\'s `docs/COPYING` to',
        '  `LICENSE` beside this file.',
        '- `bin/` holds the console build only. The GUI `ngspice.exe` never',
        '  writes stdout through a pipe, so the backend cannot drive it.',
        '- `lib/ngspice/*.cm` are the code models ngspice loads from',
        '  `../lib/ngspice` relative to the executable. Missing `analog.cm`',
        '  silently makes `.ac`/`.tran` runs exit without solving; missing',
        '  `digital.cm` removes every XSPICE part. Both are required, and the',
        '  staging step proves they load by running a real `.ac` deck.',
        '',
        'Set `AUGUST_NGSPICE_EXE` to keep a system install instead; it wins when',
        'it points at a real file. `circuit_env` reports what was found.',
        '',
      ].join('\n'),
    );
    // Marker goes in the STAGING tree, never the live one: it reaches
    // resources/ only via the rename below, so "already staged" can never be
    // claimed by a tree that was not actually swapped in.
    await writeFile(join(staged, 'staged-from.sha256'), `${NGSPICE_MARKER}\n`);

    // Accept the engine in its final layout, not in the extract dir: the share
    // tree is located relative to the executable, so a bad layout only shows
    // up here.
    await verifyNgspiceRuns(join(staged, 'bin', 'ngspice_con.exe'), NGSPICE_VERSION);

    if (existsSync(ngspiceDir)) {
      // Park the superseded tree OUTSIDE resources: `tauri.conf.json` bundles
      // `resources/**/*`, so an `ngspice.previous` sibling would ship the old
      // engine too and could win the probe. A hand-dropped tree may also be the
      // developer's only copy, so move it rather than deleting it.
      const previous = join(await mkdtemp(join(tmpdir(), 'august-ngspice-')), 'previous');
      try {
        await rename(ngspiceDir, previous);
        console.warn(
          `[prepare-backend] previous ngspice moved aside to ${previous} (delete it anytime)`,
        );
      } catch (error) {
        // EBUSY/EPERM here means a live backend has the engine mapped — it
        // spawns ngspice in server mode and keeps it running between turns.
        throw new Error(
          `cannot replace ${ngspiceDir}: ${error.code || error.message}. Close the running ` +
            'August app or dev backend (`npm run dev:desktop`, and any ngspice_con.exe it ' +
            'started) and run this step again — the bundled engine stays loaded while it runs.',
          { cause: error },
        );
      }
    }
    await mkdir(dirname(ngspiceDir), { recursive: true });
    await rename(staged, ngspiceDir);
    console.log(`[prepare-backend] staged ngspice ${NGSPICE_VERSION} → ${ngspiceDir}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
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
    run(resolveUv(), [
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
      'Do not commit the python/ / backend-py/ / wheels/ / ngspice/ trees —',
      'CI/release builds them.',
      '',
    ].join('\n'),
  );

  const pythonExe = await ensurePython();
  await ensureNgspice();
  await stageBackendSources();
  await buildWheels(pythonExe);
  await writeManifest(pythonExe);
  console.log('[prepare-backend] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
