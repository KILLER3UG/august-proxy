// scripts/prepare-desktop-backend.mjs
//
// Stages a relocatable Python runtime + backend-py sources into
// frontend/desktop/src-tauri/resources/ so the Tauri installer can ship a
// working backend (no repo checkout required).
//
// Usage:
//   node scripts/prepare-desktop-backend.mjs
//   node scripts/prepare-desktop-backend.mjs --skip-download   # reuse existing python/

import { createWriteStream } from 'node:fs';
import { mkdir, rm, cp, access, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const root = resolve(process.cwd());
const resourcesDir = resolve(root, 'frontend/desktop/src-tauri/resources');
const pythonDir = join(resourcesDir, 'python');
const backendOut = join(resourcesDir, 'backend-py');
const wheelsOut = join(resourcesDir, 'wheels');
const skipDownload = process.argv.includes('--skip-download');

// python-build-standalone — relocatable CPython for Windows x64
const PYTHON_VERSION = '3.12.9';
const PYTHON_BUILD = '20250317';
const PYTHON_URL =
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/` +
  `cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-x86_64-pc-windows-msvc-install_only.tar.gz`;

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: opts.cwd || root,
    env: { ...process.env, ...(opts.env || {}) },
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  console.log(`[prepare-backend] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(res.body, createWriteStream(dest));
  console.log(`[prepare-backend] saved ${dest}`);
}

async function extractTarGz(archive, dest) {
  await mkdir(dest, { recursive: true });
  if (process.platform === 'win32') {
    // Prefer tar.exe (Windows 10+) — handles .tar.gz
    run('tar', ['-xzf', archive, '-C', dest]);
  } else {
    run('tar', ['-xzf', archive, '-C', dest]);
  }
}

async function ensurePython() {
  const pythonExe = join(pythonDir, 'python.exe');
  if (skipDownload && (await pathExists(pythonExe))) {
    console.log('[prepare-backend] reusing existing portable python');
    return pythonExe;
  }

  await rm(pythonDir, { recursive: true, force: true });
  await mkdir(pythonDir, { recursive: true });

  const archive = join(resourcesDir, `cpython-${PYTHON_VERSION}-windows.tar.gz`);
  if (!(await pathExists(archive)) || !skipDownload) {
    await download(PYTHON_URL, archive);
  }

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
  console.log(`[prepare-backend] portable python ready: ${pythonExe}`);
  return pythonExe;
}

async function stageBackendSources() {
  await rm(backendOut, { recursive: true, force: true });
  await mkdir(backendOut, { recursive: true });

  const src = resolve(root, 'backend-py');
  // Copy package sources needed to run uvicorn app.main:app
  for (const name of ['app', 'pyproject.toml', 'README.md']) {
    const from = join(src, name);
    if (!(await pathExists(from))) continue;
    await cp(from, join(backendOut, name), {
      recursive: true,
      filter: (p) => {
        const n = p.replace(/\\/g, '/');
        if (n.includes('/__pycache__/') || n.endsWith('.pyc')) return false;
        if (n.includes('/.mypy_cache/') || n.includes('/.ruff_cache/')) return false;
        if (n.includes('/tests/')) return false;
        if (n.includes('/.venv/')) return false;
        return true;
      },
    });
  }
  console.log(`[prepare-backend] staged backend sources → ${backendOut}`);
}

async function buildWheels(pythonExe) {
  await rm(wheelsOut, { recursive: true, force: true });
  await mkdir(wheelsOut, { recursive: true });

  // Ensure pip exists in the portable build
  run(pythonExe, ['-m', 'ensurepip', '--upgrade']);
  run(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'build']);

  // Build wheels for backend-py + runtime deps (skip playwright browsers)
  run(
    pythonExe,
    [
      '-m',
      'pip',
      'wheel',
      '--wheel-dir',
      wheelsOut,
      resolve(root, 'backend-py'),
    ],
    {
      env: {
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    },
  );
  console.log(`[prepare-backend] wheels → ${wheelsOut}`);
}

async function writeManifest(pythonExe) {
  const manifest = {
    pythonVersion: PYTHON_VERSION,
    pythonBuild: PYTHON_BUILD,
    preparedAt: new Date().toISOString(),
    pythonExe: 'python/python.exe',
    backendPath: 'backend-py',
    wheelsPath: 'wheels',
  };
  await writeFile(join(resourcesDir, 'backend-runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Touch a tiny marker the Rust side can hash for rebuild detection
  const hash = createHash('sha256');
  hash.update(PYTHON_VERSION);
  hash.update(PYTHON_BUILD);
  try {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    hash.update(String(pkg.version || ''));
  } catch { /* ignore */ }
  await writeFile(join(resourcesDir, 'backend-runtime.stamp'), `${hash.digest('hex')}\n`);
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
