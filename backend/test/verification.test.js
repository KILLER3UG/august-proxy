const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const PORT = process.env.AUGUST_PROXY_TEST_PORT || '9192';
const ROOT = path.resolve(__dirname, '../..');
let backendChild = null;

function request(pathname) {
  const url = new URL(pathname, `http://127.0.0.1:${PORT}`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        const body = contentType.includes('application/json') ? JSON.parse(data) : data;
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out: ${pathname}`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(child) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited early with code ${child.exitCode}`);
    }
    try {
      const res = await request('/ui/models/catalog');
      if (res.status === 200) return;
      lastError = new Error(`GET /ui/models/catalog returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('backend did not become ready');
}

function stopBackend(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    child.once('exit', finish);
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'taskkill', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
    setTimeout(finish, 5000).unref();
  });
}

test.before(async () => {
  backendChild = spawn(process.execPath, ['backend/index.js'], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      AUGUST_PROXY_PORT: PORT,
      AUGUST_PROXY_SKIP_MCP_STARTUP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendChild.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  backendChild.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`));

  await waitForServer(backendChild);
});

test.after(() => stopBackend(backendChild));

test('backend model catalog returns a usable model list for the frontend', async () => {
  const { status, body } = await request('/ui/models/catalog');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.models), 'body.models should be an array');
  assert.ok(body.models.length > 0, 'body.models should not be empty');

  const ids = body.models.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length, 'model ids should be unique');

  for (const model of body.models) {
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.name, 'string');
    assert.equal(typeof model.provider, 'string');
    assert.equal(typeof model.contextWindow, 'number');
    assert.ok(model.contextWindow > 0);
  }
});
