/**
 * integration-test.js — Tests all new API endpoints against the running server.
 * Uses process.env.PORT to match index.js's internal server.
 * Setting it before require so index.js listens on our port.
 */
process.env.PORT = '9191';

const http = require('http');
// Requiring index.js starts its own server on LISTEN_PORT (which is now 9191)
const handler = require('./index.js');

const PORT = 9191;

function fetch(method, url, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: PORT, path: url, method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // Wait for the server started by index.js to be ready
  await new Promise(r => setTimeout(r, 500));

  // Try to connect — wait up to 5 seconds for the server to be ready
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fetch('GET', '/ui/tools');
      break;
    } catch (e) {
      if (attempt === 9) throw new Error('Server not ready after 5s: ' + e.message);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('✓ Server running on port', PORT);

  const results = { passed: 0, failed: 0 };

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      results.passed++;
    } catch (e) {
      console.log(`  ❌ ${name}: ${e.message || e}`);
      results.failed++;
    }
  }

  // ── 1. Tools List ──
  await test('GET /ui/tools — lists registered tools', async () => {
    const r = await fetch('GET', '/ui/tools');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (!Array.isArray(r.body.tools)) throw new Error('tools not an array');
    if (r.body.tools.length < 10) throw new Error(`Expected >=10 tools, got ${r.body.tools.length}`);
    if (!Array.isArray(r.body.toolsets)) throw new Error('toolsets not an array');
  });

  // ── 2. Tool Definitions ──
  await test('GET /ui/tools/definitions?format=openai', async () => {
    const r = await fetch('GET', '/ui/tools/definitions?format=openai');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (r.body.count < 10) throw new Error(`Expected >=10 definitions, got ${r.body.count}`);
  });

  // ── 3. Tool Dispatch (test dispatch of a non-existent tool returns error) ──
  await test('POST /ui/tools/dispatch — unknown tool returns error', async () => {
    const r = await fetch('POST', '/ui/tools/dispatch', JSON.stringify({ name: 'does_not_exist', args: {} }));
    if (r.status !== 500) throw new Error(`Expected 500, got ${r.status}`);
    if (!r.body.error) throw new Error('Expected error field');
  });

  // ── 4. Session Search ──
  await test('GET /ui/sessions/search?q=test', async () => {
    const r = await fetch('GET', '/ui/sessions/search?q=test');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (typeof r.body.count !== 'number') throw new Error('count not a number');
  });

  // ── 5. Sessions List ──
  await test('GET /ui/sessions', async () => {
    const r = await fetch('GET', '/ui/sessions');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (!Array.isArray(r.body.sessions)) throw new Error('sessions not an array');
    console.log(`       (${r.body.sessions.length} sessions)`);
  });

  // ── 6. Session by ID (404 for missing) ──
  await test('GET /ui/sessions/nonexistent — 404', async () => {
    const r = await fetch('GET', '/ui/sessions/nonexistent');
    if (r.status !== 404) throw new Error(`Expected 404, got ${r.status}`);
  });

  // ── 7. Model Catalog ──
  await test('GET /ui/models/catalog', async () => {
    const r = await fetch('GET', '/ui/models/catalog');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (r.body.count < 10) throw new Error(`Expected >=10 models, got ${r.body.count}`);
    console.log(`       (${r.body.count} models)`);
    // Check specific model
    const sonnet = r.body.models.find(m => m.id === 'claude-sonnet-4-6');
    if (!sonnet) throw new Error('Expected claude-sonnet-4-6 in catalog');
    if (sonnet.contextWindow !== 200000) throw new Error(`Expected 200k context, got ${sonnet.contextWindow}`);
  });

  // ── 8. Model Catalog with provider filter ──
  await test('GET /ui/models/catalog?provider=anthropic', async () => {
    const r = await fetch('GET', '/ui/models/catalog?provider=anthropic');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (r.body.count < 3) throw new Error(`Expected >=3 anthropic models, got ${r.body.count}`);
    r.body.models.forEach(m => { if (m.provider !== 'anthropic') throw new Error(`Non-anthropic model: ${m.id}`); });
  });

  // ── 9. Model Capabilities ──
  await test('GET /ui/models/capabilities', async () => {
    const r = await fetch('GET', '/ui/models/capabilities');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (!Array.isArray(r.body.capabilities)) throw new Error('capabilities not an array');
    if (r.body.capabilities.length < 5) throw new Error(`Expected >=5 capabilities, got ${r.body.capabilities.length}`);
    console.log(`       (${r.body.capabilities.length} capabilities)`);
  });

  // ── 10. Cost Estimation ──
  await test('POST /ui/models/estimate-cost', async () => {
    const r = await fetch('POST', '/ui/models/estimate-cost', JSON.stringify({ modelId: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 500 }));
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (!r.body.model) throw new Error('Expected model field');
    if (typeof r.body.cost?.input !== 'number') throw new Error('Expected cost.input');
  });

  // ── 11. MCP OAuth Status ──
  await test('GET /ui/mcp-oauth/status?server=linear', async () => {
    const r = await fetch('GET', '/ui/mcp-oauth/status?server=linear');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (typeof r.body.authenticated !== 'boolean') throw new Error('Expected authenticated boolean');
  });

  // ── 12. Cron Jobs ──
  await test('GET /ui/cron', async () => {
    const r = await fetch('GET', '/ui/cron');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (!Array.isArray(r.body.jobs)) throw new Error('jobs not an array');
  });

  // ── 13. Skills V2 ──
  await test('GET /ui/skills-v2', async () => {
    const r = await fetch('GET', '/ui/skills-v2');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (!Array.isArray(r.body.skills)) throw new Error('skills not an array');
    console.log(`       (${r.body.skills.length} skills)`);
  });

  // ── 14. Model Aliases ──
  await test('GET /ui/models/aliases', async () => {
    const r = await fetch('GET', '/ui/models/aliases');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    if (!Array.isArray(r.body.aliases)) throw new Error('aliases not an array');
  });

  // ── 15. Providers endpoint ──
  await test('GET /ui/providers/options', async () => {
    const r = await fetch('GET', '/ui/providers/options');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    const count = r.body.providers?.length;
    if (count < 25) throw new Error(`Expected >=25 providers, got ${count}`);
    console.log(`       (${count} providers)`);
  });

  // ── Summary ──
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Results: ${results.passed} passed, ${results.failed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
