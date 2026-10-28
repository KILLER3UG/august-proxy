#!/usr/bin/env node
/**
 * gates.mjs — the ONE list of what "green" means.
 *
 * CI, the release workflow and a developer's terminal all run these groups.
 * Adding a gate means adding it here, once; a workflow that hand-lists gates
 * is how the release job came to skip ten of them.
 *
 *   node scripts/gates.mjs static     # cross-cutting Node checks
 *   node scripts/gates.mjs backend    # needs the backend interpreter
 *   node scripts/gates.mjs smoke      # starts the app against a scratch data dir
 *   node scripts/gates.mjs frontend   # needs npm dependencies
 *   node scripts/gates.mjs mobile     # Expo typecheck + parity audit
 *   node scripts/gates.mjs all        # static + backend + frontend + mobile
 *
 * `npm run gates:<group>` is the public spelling.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(root, 'backend-py');

function shellLine(cmd, args) {
  return [cmd, ...args]
    .map((arg) => (/^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`))
    .join(' ');
}

function run(cmd, args, cwd) {
  const line = shellLine(cmd, args);
  console.log(`\n==> ${line}`);
  // A command STRING, not args alongside `shell`. Node 24 deprecates the
  // latter (DEP0190) and npm on Windows is a .cmd shim that refuses to spawn
  // without a shell. Every argument here is static, never user input.
  const result = spawnSync(line, { cwd, stdio: 'inherit', shell: true });
  if (result.error) {
    console.error(`\n[gates] ${cmd} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n[gates] FAILED: ${line} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

function hasCommand(cmd, args) {
  return spawnSync(shellLine(cmd, args), { stdio: 'ignore', shell: true }).status === 0;
}

const GROUPS = {
  static: [
    ['npm', ['run', 'check:naming'], root],
    ['npm', ['run', 'check:api-index'], root],
    ['npm', ['run', 'check:sse'], root],
    ['npm', ['run', 'check:minisign'], root],
    ['npm', ['run', 'check:version'], root],
    ['npm', ['run', 'check:docs'], root],
    ['npm', ['run', 'check:doc-links'], root],
    ['npm', ['run', 'check:tool-registration'], root],
  ],
  backend: [
    ['npm', ['run', 'check:api'], root],
    ['npm', ['run', 'check:brain-config'], root],
    ['lint', [], backend],
    ['npm', ['run', 'e2e:smoke'], root],
  ],
  smoke: [
    ['npm', ['run', 'e2e:smoke'], root],
  ],
  frontend: [
    ['npm', ['run', 'check:truncate'], root],
    ['npm', ['run', 'check:design'], root],
    ['npm', ['run', 'lint:ratchet'], root],
    ['npm', ['run', 'check', '-w', 'frontend/desktop'], root],
    ['npm', ['run', 'build:web'], root],
    ['apigen', [], root],
  ],
  mobile: [
    ['npm', ['run', 'test', '-w', 'frontend/mobile'], root],
  ],
};

function backendLint() {
  if (hasCommand('uv', ['--version'])) {
    run('uv', ['run', 'ruff', 'check', '.'], backend);
    run('uv', ['run', 'mypy', 'app/'], backend);
    return;
  }
  const python = hasCommand('python', ['--version'])
    ? ['python', []]
    : hasCommand('py', ['-3', '--version'])
      ? ['py', ['-3']]
      : null;
  if (!python) {
    console.error('\n[gates] no backend interpreter found: install uv, or put python on PATH');
    process.exit(1);
  }
  const [cmd, prefix] = python;
  run(cmd, [...prefix, '-m', 'ruff', 'check', '.'], backend);
  run(cmd, [...prefix, '-m', 'mypy', 'app/'], backend);
}

function apiGen() {
  run('npm', ['run', 'gen:api'], root);
  const status = spawnSync(
    shellLine('git', ['status', '--porcelain', '--', 'frontend/desktop/src/api/gen/openapi.ts']),
    { cwd: root, encoding: 'utf8', shell: true },
  );
  if (status.error || status.status !== 0) {
    console.error('\n[gates] could not read git status for the generated API types');
    process.exit(1);
  }
  if (status.stdout.trim()) {
    console.error(
      '\n[gates] FAILED: frontend/desktop/src/api/gen/openapi.ts is out of sync '
        + 'with docs/api/openapi.json. Run npm run gen:api and commit the result.',
    );
    process.exit(1);
  }
}

function runGroup(name) {
  const steps = GROUPS[name];
  if (!steps) {
    console.error(`[gates] unknown group: ${name}`);
    console.error(`[gates] groups: ${Object.keys(GROUPS).join(', ')}`);
    process.exit(2);
  }
  for (const [cmd, args, cwd] of steps) {
    if (cmd === 'lint') backendLint();
    else if (cmd === 'apigen') apiGen();
    else run(cmd, args, cwd);
  }
}

const requested = process.argv.slice(2);
if (requested.length === 0 || requested.includes('--help') || requested.includes('-h')) {
  console.log('usage: node scripts/gates.mjs <group>...');
  console.log(`groups: ${Object.keys(GROUPS).join(', ')}, all`);
  process.exit(requested.length === 0 ? 2 : 0);
}

if (!existsSync(resolve(root, 'package.json'))) {
  console.error('[gates] run from the repository root');
  process.exit(2);
}

const names = requested.includes('all') ? ['static', 'backend', 'frontend', 'mobile'] : requested;
for (const name of names) {
  console.log(`\n=== gates: ${name} ===`);
  runGroup(name);
}
console.log('\nAll requested gate groups passed.');
