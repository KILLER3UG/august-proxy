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

// What a running August writes for ONE person: the memory database, provider
// credentials, session transcripts, learned-skill counters. Staging copies
// straight out of a working checkout, and one launch with AUGUST_DATA_DIR
// pointed into that checkout drops all of them there — at which point a release
// would ship a developer's history (and their API keys) inside the installer,
// so a "first download" opens with somebody else's memory and the next update
// overwrites the real user's stores with the shipped copy. None of these names
// exists in the source tree today, so if staging ever starts dropping one, that
// is the build catching the leak rather than a silent change in what ships.
const userStateNames = new Set([
  'config.json', 'providers.json', 'mcp-servers.json', 'workbench-sessions.json',
  'automations.json', 'scheduled-jobs.json', 'harness-activity.json', 'hooks.json',
  '.env', '.env.local', '.usage.json',
]);
const userStateDirs = new Set([
  'data', 'backups', 'logs', 'harness_proposals', 'shadow-git', 'checkpoints',
  'event_log', 'refine_store',
]);
const userStateSuffixes = [
  '.sqlite', '.sqlite-wal', '.sqlite-shm', '.pre-migration', '.pre-migration-wal',
  '.db', '.key', '.pem', '.p12',
];

function userStateReason(parts) {
  const name = parts.at(-1);
  if (parts.some((part) => userStateDirs.has(part))) return 'user-state directory';
  if (userStateNames.has(name)) return 'user-state file';
  if (userStateSuffixes.some((suffix) => name.endsWith(suffix))) return 'database or key file';
  return null;
}

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
    if (userStateReason(parts)) return false;
    return !parts.some(part => cacheDirs.has(part) || generatedDirs.has(part) || (excludeTests && part === 'tests'))
      && !name.endsWith('.egg-info')
      && !path.endsWith('.pyc');
  };
}

/** Fail a release build whose staged payload contains anything a running
 *  August would have written for one specific human.
 *
 *  Checked after staging rather than only filtered during it: the sidecar's
 *  `npm ci` runs inside the payload, a stale tree can survive an interrupted
 *  build, and the thing worth protecting here is a user's memory database and
 *  provider keys, so the build reads the shipped bytes before stamping them.
 *  Third-party runtimes (wheels, portable python, node_modules, binaries) are
 *  deliberately not walked — a python package legitimately owns `data/` and
 *  `logs/` directories, and none of them can hold August user state. */
export async function assertPayloadHasNoUserState(resourcesDir) {
  const offenders = [];
  const roots = [
    [join(resourcesDir, 'backend-py', 'app'), 'backend-py/app'],
    [join(resourcesDir, 'backend-py', 'sidecar'), 'backend-py/sidecar'],
    [join(resourcesDir, 'skills'), 'skills'],
  ];
  async function walk(path, name) {
    if (!await exists(path)) return;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (cacheDirs.has(entry.name)) continue;
      const childName = `${name}/${entry.name}`;
      const reason = userStateReason(childName.split('/'));
      if (reason) {
        offenders.push(`${reason}: ${childName}`);
        continue;
      }
      if (entry.isDirectory()) await walk(join(path, entry.name), childName);
    }
  }
  for (const [path, name] of roots) await walk(path, name);
  if (offenders.length) {
    throw new Error(
      'staged payload contains user state and must not ship — a fresh install '
      + `would inherit it and an update could overwrite real data:\n  ${offenders.join('\n  ')}`,
    );
  }
  return offenders;
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
  await assertPayloadHasNoUserState(resourcesDir);
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
