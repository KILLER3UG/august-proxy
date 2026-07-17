#!/usr/bin/env node

/**
 * Mobile parity audit against the Python FastAPI backend (/api/*).
 * Legacy Node /ui/* paths and apps/proxy/src/ui are not used.
 */

const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const desktopSrc = path.join(repoRoot, 'frontend', 'desktop', 'src');
const baseUrl = (process.env.AUGUST_AUDIT_BASE_URL || 'http://127.0.0.1:8085').replace(/\/+$/, '');

const failures = [];
const passes = [];

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function check(condition, message) {
  if (condition) {
    passes.push(message);
  } else {
    failures.push(message);
  }
}

function walkFiles(root, options = {}) {
  const ignored = new Set(options.ignored || []);
  const extensions = new Set(options.extensions || []);
  const files = [];

  function walk(current) {
    if (!fs.existsSync(current)) return;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      const name = path.basename(current);
      if (ignored.has(name)) return;
      for (const entry of fs.readdirSync(current)) {
        walk(path.join(current, entry));
      }
      return;
    }
    if (!extensions.size || extensions.has(path.extname(current))) {
      files.push(current);
    }
  }

  walk(root);
  return files;
}

function extractApiEndpoints(text) {
  const endpoints = new Set();
  const quoted = /['"`](\/api\/[^'"`<>\s)]+)/g;
  let match;
  while ((match = quoted.exec(text))) {
    endpoints.add(match[1].replace(/\\\$/g, '$'));
  }
  return endpoints;
}

function extractLegacyUiEndpoints(text) {
  const endpoints = new Set();
  const quoted = /['"`](\/ui\/[^'"`<>\s)]+)/g;
  let match;
  while ((match = quoted.exec(text))) {
    endpoints.add(match[1].replace(/\\\$/g, '$'));
  }
  return endpoints;
}

function runStaticAudit() {
  const appTsxPath = path.join(appRoot, 'App.tsx');
  const packageJsonPath = path.join(appRoot, 'package.json');
  const appJsonPath = path.join(appRoot, 'app.json');
  const nativeApiPath = path.join(appRoot, 'src', 'api', 'proxy.ts');

  const appTsx = readText(appTsxPath);
  const packageJson = readJson(packageJsonPath);
  const appJson = readJson(appJsonPath);

  check(appTsx.includes('react-native-webview'), 'mobile renders the shared web app through react-native-webview');
  check(appTsx.includes('source={{ uri: proxyUrl }}'), 'WebView source is the configured proxy URL');
  check(appTsx.includes('MOBILE_WEB_BOOTSTRAP'), 'mobile WebView injects mobile shell bootstrap');
  check(!fs.existsSync(nativeApiPath), 'old native mobile API wrapper has been removed');

  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const bannedDeps = [
    '@react-navigation/bottom-tabs',
    '@react-navigation/native',
    '@react-navigation/native-stack',
    'react-native-screens',
  ];
  check(!bannedDeps.some((name) => deps[name]), 'bottom-tab/native navigation dependencies are absent');
  check(Boolean(deps['react-native-webview']), 'react-native-webview dependency is installed');

  check(appJson.expo?.userInterfaceStyle === 'automatic', 'Expo app uses automatic light/dark appearance');
  check(appJson.expo?.android?.usesCleartextTraffic === true, 'Android can connect to local HTTP proxy during development');
  check((appJson.expo?.android?.permissions || []).includes('INTERNET'), 'Android INTERNET permission is declared');

  const mobileFiles = [
    appTsxPath,
    ...walkFiles(path.join(appRoot, 'src'), {
      ignored: ['node_modules', '.expo'],
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    }),
  ];
  const mobileText = mobileFiles.map(readText).join('\n');
  check(!/@react-navigation|bottom-tabs|TabNavigator|BottomTab/.test(mobileText), 'mobile source has no bottom navigation implementation');
  check(extractLegacyUiEndpoints(mobileText).size === 0, 'mobile source has no native /ui endpoint list');

  // Desktop web UI is the shared surface (Python backend + React desktop).
  check(fs.existsSync(desktopSrc), 'desktop frontend source is present for shared web surface');
  const desktopFiles = walkFiles(desktopSrc, {
    ignored: ['node_modules'],
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  });
  const desktopText = desktopFiles.map(readText).join('\n');
  const legacyUi = extractLegacyUiEndpoints(desktopText);
  check(
    legacyUi.size === 0,
    `desktop source has no live /ui/* API paths (found ${legacyUi.size}: ${[...legacyUi].slice(0, 5).join(', ')})`,
  );
  const apiEndpoints = extractApiEndpoints(desktopText);
  check(apiEndpoints.size >= 20, `desktop API surface detected (${apiEndpoints.size} /api references)`);

  return { apiEndpointCount: apiEndpoints.size, desktopFileCount: desktopFiles.length };
}

async function readResponse(res) {
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  return { text, json };
}

async function requestJson(endpoint, options = {}) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await readResponse(res);
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${endpoint} returned ${res.status}: ${body.text.slice(0, 200)}`);
  }
  if (!body.json) {
    throw new Error(`${options.method || 'GET'} ${endpoint} did not return JSON`);
  }
  return body.json;
}

async function requestText(endpoint) {
  const res = await fetch(`${baseUrl}${endpoint}`, { cache: 'no-store' });
  const body = await readResponse(res);
  if (!res.ok) {
    throw new Error(`GET ${endpoint} returned ${res.status}: ${body.text.slice(0, 200)}`);
  }
  return body.text;
}

async function runLiveAudit() {
  const html = await requestText('/');
  check(/August|Workbench|dashboard/i.test(html), 'web app root is reachable');

  const health = await requestJson('/api/health');
  check(Boolean(health.status || health.ok !== undefined || health.checks), '/api/health returns health data');

  const config = await requestJson('/api/config/safe');
  check(typeof config === 'object' && config !== null, '/api/config/safe returns safe settings data');

  const stats = await requestJson('/api/stats?period=all');
  check(
    typeof stats.totalRequests === 'number' ||
      typeof stats.totalTokens === 'number' ||
      typeof stats.estimatedTotalCost === 'number',
    '/api/stats?period=all returns numeric dashboard data',
  );

  const requests = await requestJson('/api/requests?period=all');
  check(
    Array.isArray(requests) || Array.isArray(requests.requests) || Array.isArray(requests.completed),
    '/api/requests?period=all returns request rows',
  );

  const sessions = await requestJson('/api/workbench/sessions');
  check(
    Array.isArray(sessions) || Array.isArray(sessions.sessions),
    '/api/workbench/sessions returns session history',
  );

  const capabilities = await requestJson('/api/workbench/capabilities');
  check(
    Boolean(capabilities.groups || capabilities.tools || capabilities.families || capabilities.sources),
    '/api/workbench/capabilities returns tool data',
  );

  const agents = await requestJson('/api/workbench/agents?active=build');
  check(
    Boolean(Array.isArray(agents.agents) || Array.isArray(agents)),
    '/api/workbench/agents returns agent choices',
  );

  const session = await requestJson('/api/workbench/session', {
    method: 'POST',
    body: JSON.stringify({ provider: 'claude', agentId: 'build' }),
  });
  check(Boolean(session.id), 'Workbench session can be created');

  const condition = `mobile parity audit ${Date.now()}`;
  const setGoal = await requestJson('/api/workbench/goal', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, action: 'set', condition }),
  });
  check(JSON.stringify(setGoal).includes(condition), 'Workbench goal state persists after set');

  const goalStatus = await requestJson('/api/workbench/goal', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, action: 'status' }),
  });
  check(JSON.stringify(goalStatus).includes(condition), 'Workbench goal state reloads through status action');

  const clearGoal = await requestJson('/api/workbench/goal', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, action: 'clear' }),
  });
  check(!JSON.stringify(clearGoal.goal || '').includes(condition), 'Workbench goal state clears');
}

async function main() {
  const staticResult = runStaticAudit();
  try {
    await runLiveAudit();
  } catch (error) {
    const cause = error && typeof error === 'object' ? error.cause : null;
    const code =
      (cause && typeof cause === 'object' && 'code' in cause && cause.code) ||
      (error && typeof error === 'object' && 'code' in error && error.code);
    if (code === 'ECONNREFUSED') {
      console.warn(
        `Skipping live mobile parity audit — backend not reachable at ${baseUrl} (${String(code)}). Static checks still apply.`,
      );
    } else {
      throw error;
    }
  }

  if (failures.length) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    console.error(`\n${failures.length} mobile parity audit check(s) failed.`);
    process.exit(1);
  }

  console.log(`Mobile parity audit passed (${passes.length} checks).`);
  console.log(
    `Mode: webview-shared-web-ui; desktop files: ${staticResult.desktopFileCount}; /api refs: ${staticResult.apiEndpointCount}; base URL: ${baseUrl}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
