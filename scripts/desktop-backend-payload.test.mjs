// Run: node --test scripts/desktop-backend-payload.test.mjs
// Uses public npm packages from the committed sidecar lock in temporary output.
// Never invokes the release entrypoint or touches real Tauri resources.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, rename, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageBackendPayload, hashStagedBackendPayload } from './desktop-backend-payload.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function put(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
function runNode(args, cwd) {
  // A clean installer need not have Node on PATH, nor NODE_PATH pointing at a
  // developer dependency tree. Use the absolute runtime path, as Tauri does.
  const result = spawnSync(process.env.AUGUST_PACKAGING_TEST_NODE || process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test('production payload works without checkout deps and hashes only shipped artifacts', { timeout: 600_000 }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'august payload test '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  // Both staged payloads install the exact same committed lock, so point npm at
  // one warm cache inside the test temp dir: the second "fresh ci" reuses
  // tarballs instead of re-downloading, which removes most of the wall-clock
  // cost (and the cold-cache timeout flake) without changing what is asserted.
  const npmCache = join(temp, 'npm-cache');
  await mkdir(npmCache, { recursive: true });
  process.env.npm_config_cache = npmCache;
  process.env.npm_config_prefer_offline = 'true';
  const source = join(temp, 'checkout');
  const output = join(temp, 'resources');
  const binaries = join(temp, 'binaries');
  const sidecarSource = join(source, 'backend-py', 'sidecar');
  const sidecarOut = join(output, 'backend-py', 'sidecar');
  for (const name of ['package.json', 'package-lock.json', 'firmware-runner.mjs']) {
    await mkdir(sidecarSource, { recursive: true });
    await cp(join(root, 'backend-py', 'sidecar', name), join(sidecarSource, name));
  }
  await cp(
    join(root, 'backend-py', 'pyproject.toml'),
    join(source, 'backend-py', 'pyproject.toml'),
  );
  // A dev-only local dependency proves --omit=dev without another registry fetch.
  const pkg = JSON.parse(await readFile(join(sidecarSource, 'package.json')));
  const lock = JSON.parse(await readFile(join(sidecarSource, 'package-lock.json')));
  pkg.devDependencies = { 'packaging-dev-only': 'file:./dev-only' };
  lock.packages[''].devDependencies = pkg.devDependencies;
  lock.packages['node_modules/packaging-dev-only'] = { resolved: 'dev-only', link: true };
  lock.packages['dev-only'] = { name: 'packaging-dev-only', version: '1.0.0', dev: true };
  await put(join(sidecarSource, 'dev-only', 'package.json'), JSON.stringify({ name: 'packaging-dev-only', version: '1.0.0' }));
  await writeFile(join(sidecarSource, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(sidecarSource, 'package-lock.json'), JSON.stringify(lock));
  await put(join(source, 'backend-py', 'app', 'main.py'), 'print("fixture")\n');
  await put(join(source, 'backend-py', 'app', '__pycache__', 'main.pyc'), 'cache');
  await put(join(source, 'backend-py', 'app', 'tests', 'test_noise.py'), 'dev tests');
  await put(join(sidecarSource, 'node_modules', 'avr8js', 'package.json'), 'poisoned local dependency');
  await put(join(source, 'skills', 'fixture', 'tests', 'example.py'), 'shipped skill example');
  await put(join(source, 'skills', 'fixture', '.usage.json'), '{"calls":999}');
  await put(join(source, 'skills', 'fixture', '__pycache__', 'example.pyc'), 'cache');
  await put(join(output, 'backend-py', 'stale.txt'), 'stale backend');
  await put(join(output, 'skills', 'stale.txt'), 'stale skill');
  await stageBackendPayload(source, output);
  await put(join(output, 'wheels', 'runtime.whl'), 'locked wheel');
  await put(join(binaries, 'node-test.exe'), 'bundled node binary');
  await put(join(output, 'python', 'python.exe'), 'portable python');
  await put(join(output, 'backend-runtime.json'), JSON.stringify({
    preparedAt: '2026-09-17T00:00:00.000Z',
    appVersion: 'test',
  }, null, 2));
  for (const path of [
    'backend-py/stale.txt', 'skills/stale.txt', 'backend-py/app/__pycache__',
    'backend-py/app/tests', 'skills/fixture/.usage.json',
    'skills/fixture/__pycache__',
    'backend-py/sidecar/node_modules/packaging-dev-only',
  ]) assert.equal(existsSync(join(output, path)), false, path);
  assert.ok(existsSync(join(output, 'skills', 'fixture', 'tests', 'example.py')));
  const stagedAvr = JSON.parse(await readFile(join(sidecarOut, 'node_modules', 'avr8js', 'package.json')));
  assert.equal(stagedAvr.version, lock.packages['node_modules/avr8js'].version);

  const initial = await hashStagedBackendPayload(output);
  const manifestPath = join(output, 'backend-runtime.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.preparedAt = 'changed';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(await hashStagedBackendPayload(output), initial, 'preparedAt is not payload content');
  manifest.preparedAt = '2026-09-17T00:00:00.000Z';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(join(output, 'wheels'), { recursive: true });
  await assert.rejects(
    hashStagedBackendPayload(output),
    /staged payload root is missing or empty: wheels/,
  );
  await put(join(output, 'wheels', 'runtime.whl'), 'locked wheel');
  assert.equal(await hashStagedBackendPayload(output), initial);
  await rm(join(binaries), { recursive: true });
  await assert.rejects(
    hashStagedBackendPayload(output),
    /staged payload root is missing or empty: binaries/,
  );
  await put(join(binaries, 'node-test.exe'), 'bundled node binary');
  assert.equal(await hashStagedBackendPayload(output), initial);
  const usageSidecar = join(output, 'skills', 'fixture', '.usage.json');
  await writeFile(usageSidecar, '{"calls":1}');
  assert.equal(await hashStagedBackendPayload(output), initial, 'usage sidecars are not payload content');
  await rm(usageSidecar);
  await utimes(join(output, 'backend-py', 'app', 'main.py'), new Date(0), new Date(0));
  assert.equal(await hashStagedBackendPayload(output), initial, 'mtimes are not payload content');
  await put(join(sidecarSource, 'node_modules', 'noise.txt'), 'new local dependency');
  await put(join(source, 'backend-py', 'app', 'main.py'), 'changed but not staged');
  assert.equal(await hashStagedBackendPayload(output), initial, 'hash must not read checkout');
  await put(join(source, 'backend-py', 'app', 'main.py'), 'print("fixture")\n');
  await rm(join(sidecarSource, 'node_modules'), { recursive: true });
  await stageBackendPayload(source, output);
  assert.equal(await hashStagedBackendPayload(output), initial, 'fresh ci must reproduce payload without local deps');

  // Exercise the real runner, not merely require.resolve. AVR RJMP -1 loops
  // indefinitely until the bounded simulator time expires (no compiler needed).
  const hex = join(temp, 'loop.hex');
  await writeFile(hex, ':02000000FFCF30\n:00000001FF\n');
  const result = JSON.parse(runNode([join(sidecarOut, 'firmware-runner.mjs'), '--hex', hex, '--ms', '1', '--pins', '13'], temp));
  assert.equal(result.ok, true);
  assert.ok(result.cycles >= 16_000);
  assert.equal(result.simulatedMs, 1);
  const wave = join(temp, 'wave.json');
  const svg = join(temp, 'wave.svg');
  const png = join(temp, 'wave.png');
  await writeFile(wave, JSON.stringify({ signal: [{ name: 'clk', wave: 'p...' }] }));
  runNode([join(sidecarOut, 'node_modules', 'wavedrom-cli', 'wavedrom-cli.js'), '-i', wave, '-s', svg, '-p', png], temp);
  assert.match(await readFile(svg, 'utf8'), /<svg/);
  assert.equal((await readFile(png)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(await hashStagedBackendPayload(output), initial, 'sidecars must not modify installed payload');

  for (const name of [
    'backend-py/app/main.py',
    'backend-py/sidecar/node_modules/avr8js/package.json',
    'skills/fixture/tests/example.py',
  ]) {
    const path = join(output, name);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('\nchanged')]));
    assert.notEqual(await hashStagedBackendPayload(output), initial, `artifact changes: ${name}`);
    await writeFile(path, original);
  }
  const added = join(output, 'backend-py', 'generated.bin');
  await writeFile(added, 'generated artifact');
  const withAddition = await hashStagedBackendPayload(output);
  assert.notEqual(withAddition, initial);
  await rename(added, added + '.renamed');
  assert.notEqual(await hashStagedBackendPayload(output), withAddition, 'paths affect hash');
  await rm(added + '.renamed');
  assert.equal(await hashStagedBackendPayload(output), initial);

  // Guard destructive staging and fail closed when a required lock is missing.
  await assert.rejects(stageBackendPayload(source, source), /overlap/);
  const skillsFixture = join(source, 'skills');
  const skillsBackup = join(temp, 'skills-backup');
  await rename(skillsFixture, skillsBackup);
  await assert.rejects(stageBackendPayload(source, output), /skills source is missing or empty/);
  await rename(skillsBackup, skillsFixture);
  assert.equal(await hashStagedBackendPayload(output), initial, 'missing skills do not erase prior output');
  await rm(join(sidecarSource, 'package-lock.json'));
  await assert.rejects(stageBackendPayload(source, output), /ENOENT/);
  assert.equal(await hashStagedBackendPayload(output), initial, 'missing lock does not erase prior output');
  t.diagnostic(`avr8js ${stagedAvr.version}: 1ms firmware simulation; WaveDrom SVG+PNG; two identical clean npm ci payloads`);
});
