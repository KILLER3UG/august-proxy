// Payload-only staging: safe to exercise with temporary fixtures, without
// downloading Python, building wheels, or touching the real Tauri resources.
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const cacheDirs = new Set([
  'node_modules', '__pycache__', '.mypy_cache', '.ruff_cache', '.pytest_cache',
  '.venv', '.tox', '.nox', '.coverage', 'htmlcov',
]);
const generatedDirs = new Set(['build', 'dist', 'august_proxy.egg-info']);

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function directoryHasFiles(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await directoryHasFiles(join(path, entry.name))) return true;
  }
  return false;
}

function sourceFilter(source, excludeTests) {
  return (path) => {
    const parts = relative(source, path).split(/[\\/]/);
    const name = parts.at(-1);
    return !parts.some(part => cacheDirs.has(part) || generatedDirs.has(part) || (excludeTests && part === 'tests'))
      && name !== '.usage.json'
      && !name.endsWith('.egg-info')
      && !path.endsWith('.pyc');
  };
}

export function installSidecarDependencies(sidecarOut) {
  // Invoke npm through cmd.exe without shell concatenation on Windows.
  // Never install in/copy from the developer tree. Lock integrity + ci prevent
  // floating dependency resolution; no package lifecycle scripts during staging.
  const npmArgs = [
    'ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund',
  ];
  const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const npmSpawnArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs]
    : npmArgs;
  const result = spawnSync(npmCommand, npmSpawnArgs, {
    cwd: sidecarOut,
    env: { ...process.env, NODE_ENV: 'production' },
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`sidecar npm ci failed (${result.signal || result.status})`);
}

export async function stageBackendPayload(root, resourcesDir) {
  const source = resolve(root, 'backend-py');
  const backendOut = resolve(resourcesDir, 'backend-py');
  const skillsSource = resolve(root, 'skills');
  const skillsOut = resolve(resourcesDir, 'skills');
  // Refuse overlapping source/destination trees before any destructive cleanup.
  for (const [from, to] of [[source, backendOut], [skillsSource, skillsOut]]) {
    for (const [a, b] of [[from, to], [to, from]]) {
      const rel = relative(a, b);
      if (!rel || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))) {
        throw new Error(`Payload source/output overlap: ${from} / ${to}`);
      }
    }
  }
  // Missing runtime entry points must fail closed, not quietly ship an unusable payload.
  for (const name of ['app/main.py', 'pyproject.toml', 'sidecar/package.json', 'sidecar/package-lock.json', 'sidecar/firmware-runner.mjs']) {
    await readFile(join(source, name));
  }
  if (!(await exists(skillsSource)) || !(await directoryHasFiles(skillsSource))) {
    throw new Error('skills source is missing or empty');
  }
  await rm(backendOut, { recursive: true, force: true });
  await mkdir(backendOut, { recursive: true });
  for (const name of ['app', 'sidecar', 'pyproject.toml', 'README.md']) {
    const from = join(source, name);
    if (await exists(from)) {
      await cp(from, join(backendOut, name), { recursive: true, filter: sourceFilter(source, true) });
    }
  }
  installSidecarDependencies(join(backendOut, 'sidecar'));
  if (!(await directoryHasFiles(backendOut))) {
    throw new Error('staged backend payload is empty');
  }

  // Always clear stale skills, including when the source directory disappeared.
  await rm(skillsOut, { recursive: true, force: true });
  await cp(skillsSource, skillsOut, { recursive: true, filter: sourceFilter(skillsSource, false) });
  if (!(await directoryHasFiles(skillsOut))) {
    throw new Error('staged skills payload is empty');
  }
}

export async function hashStagedBackendPayload(resourcesDir) {
  const hash = createHash('sha256');
  // Hash the actual shipped tree. Installed dependencies, skill tests and
  // generated files are included; runtime usage sidecars and the volatile
  // preparedAt field are not payload content. Length-framed records avoid
  // ambiguous path/content concatenation; ordering is locale-independent and
  // excludes mtimes/absolute developer paths.
  async function visit(path, name) {
    const info = await stat(path); // follows npm's executable symlinks on Unix
    if (info.isDirectory()) {
      hash.update(JSON.stringify(['dir', name]) + '\n');
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`);
    } else if (info.isFile()) {
      if (name.split('/').at(-1) === '.usage.json') return;
      const data = await readFile(path);
      hash.update(JSON.stringify(['file', name, data.length]) + '\n');
      hash.update(data);
    } else {
      throw new Error(`Unsupported staged payload entry: ${path}`);
    }
  }
  for (const name of ['backend-py', 'skills', 'wheels']) {
    const path = join(resourcesDir, name);
    if (!(await exists(path)) || !(await directoryHasFiles(path))) {
      throw new Error(`staged payload root is missing or empty: ${name}`);
    }
    await visit(path, name);
  }
  const binariesDir = join(dirname(resourcesDir), 'binaries');
  if (!(await exists(binariesDir)) || !(await directoryHasFiles(binariesDir))) {
    throw new Error('staged payload root is missing or empty: binaries');
  }
  await visit(binariesDir, 'binaries');
  const pythonPath = join(resourcesDir, 'python');
  if (!(await exists(pythonPath))) {
    throw new Error('staged payload root is missing: python');
  }
  await visit(pythonPath, 'python');
  const manifestPath = join(resourcesDir, 'backend-runtime.json');
  if (!(await exists(manifestPath))) {
    throw new Error('staged payload manifest is missing: backend-runtime.json');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.preparedAt;
  const canonical = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  hash.update(JSON.stringify(['file', 'backend-runtime.json', canonical.length]) + '\n');
  hash.update(canonical);
  return hash.digest('hex');
}
