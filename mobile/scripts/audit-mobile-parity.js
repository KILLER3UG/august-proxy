#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
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

function extractUiEndpoints(text) {
  const endpoints = new Set();
  const quoted = /['"`](\/ui\/[^'"`<>\s)]+)/g;
  let match;
  while ((match = quoted.exec(text))) {
    endpoints.add(match[1].replace(/\\\$/g, '$'));
  }
  return endpoints;
}

function extractSectionsFromSidebar(text) {
  const sections = new Set();
  const sectionAttr = /data-section=["']([^"']+)["']/g;
  let match;
  while ((match = sectionAttr.exec(text))) {
    sections.add(match[1]);
  }
  return sections;
}

function extractSectionIds(text) {
  const sections = new Set();
  const sectionId = /id=["']section-([^"']+)["']/g;
  let match;
  while ((match = sectionId.exec(text))) {
    sections.add(match[1]);
  }
  return sections;
}

function runStaticAudit() {
  const appTsxPath = path.join(appRoot, 'App.tsx');
  const packageJsonPath = path.join(appRoot, 'package.json');
  const appJsonPath = path.join(appRoot, 'app.json');
  const cssPath = path.join(repoRoot, 'apps', 'proxy', 'src', 'ui', 'css', 'styles.css');
  const sidebarPath = path.join(repoRoot, 'apps', 'proxy', 'src', 'ui', 'partials', 'sidebar.html');
  const sectionsRoot = path.join(repoRoot, 'apps', 'proxy', 'src', 'ui', 'partials', 'sections');
  const nativeApiPath = path.join(appRoot, 'src', 'api', 'proxy.ts');

  const appTsx = readText(appTsxPath);
  const packageJson = readJson(packageJsonPath);
  const appJson = readJson(appJsonPath);
  const css = readText(cssPath);
  const sidebar = readText(sidebarPath);

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

  check(css.includes('Mobile WebView/Layout Parity'), 'shared web CSS contains the mobile parity block');
  check(/@media\s*\(max-width:\s*768px\)/.test(css), 'shared web CSS has a mobile breakpoint');
  check(/overflow-x:\s*hidden/.test(css), 'mobile layout hides horizontal overflow');
  check(css.includes('.wb-agent-card.is-active'), 'Workbench active agent card has a neutral mobile override');
  check(css.includes('#workbenchSendBtn'), 'Workbench send control is covered by mobile neutral styling');

  const mobileFiles = [
    appTsxPath,
    ...walkFiles(path.join(appRoot, 'src'), {
      ignored: ['node_modules', '.expo'],
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    }),
  ];
  const mobileText = mobileFiles.map(readText).join('\n');
  check(!/@react-navigation|bottom-tabs|TabNavigator|BottomTab/.test(mobileText), 'mobile source has no bottom navigation implementation');
  check(extractUiEndpoints(mobileText).size === 0, 'mobile source has no native /ui endpoint list to drift from web');

  const webSections = extractSectionsFromSidebar(sidebar);
  const sectionIds = new Set();
  for (const file of walkFiles(sectionsRoot, { extensions: ['.html'] })) {
    for (const section of extractSectionIds(readText(file))) {
      sectionIds.add(section);
    }
  }
  check(webSections.size >= 13, `web sidebar feature surface detected (${webSections.size} sections)`);
  for (const section of webSections) {
    check(sectionIds.has(section), `web feature section "${section}" has a matching screen`);
  }

  const uiFiles = walkFiles(path.join(repoRoot, 'apps', 'proxy', 'src', 'ui'), {
    ignored: ['node_modules'],
    extensions: ['.js', '.html'],
  }).filter((file) => !file.endsWith('ui_backup.html'));
  const webEndpoints = new Set();
  for (const file of uiFiles) {
    for (const endpoint of extractUiEndpoints(readText(file))) {
      webEndpoints.add(endpoint);
    }
  }
  check(webEndpoints.size >= 40, `web UI endpoint surface detected (${webEndpoints.size} /ui references)`);

  return { webEndpointCount: webEndpoints.size, webSectionCount: webSections.size };
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
  check(/dashboard|Workbench|August/i.test(html), 'web app root is reachable');

  const liveSections = extractSectionIds(html);
  const sidebar = readText(path.join(repoRoot, 'apps', 'proxy', 'src', 'ui', 'partials', 'sidebar.html'));
  for (const section of extractSectionsFromSidebar(sidebar)) {
    check(liveSections.has(section), `live web app includes feature section "${section}"`);
  }

  const health = await requestJson('/ui/health');
  check(Boolean(health.summary || health.cards || health.checks), '/ui/health returns dashboard health data');

  const config = await requestJson('/ui/config/safe');
  check(typeof config === 'object' && config !== null, '/ui/config/safe returns safe settings data');

  const stats = await requestJson('/ui/stats?period=all');
  check(
    typeof stats.totalRequests === 'number' &&
      typeof stats.totalTokens === 'number' &&
      typeof stats.estimatedTotalCost === 'number',
    '/ui/stats?period=all returns numeric dashboard data',
  );

  const requests = await requestJson('/ui/requests?period=all');
  check(
    Array.isArray(requests) || Array.isArray(requests.requests) || Array.isArray(requests.completed),
    '/ui/requests?period=all returns request rows',
  );

  const sessions = await requestJson('/ui/workbench/sessions');
  check(Array.isArray(sessions), '/ui/workbench/sessions returns session history');

  const capabilities = await requestJson('/ui/workbench/capabilities');
  check(Boolean(capabilities.groups || capabilities.tools || capabilities.families), '/ui/workbench/capabilities returns tool data');

  const agents = await requestJson('/ui/workbench/agents?active=build');
  check(Boolean(Array.isArray(agents.agents) || Array.isArray(agents)), '/ui/workbench/agents returns agent choices');

  const session = await requestJson('/ui/workbench/session', {
    method: 'POST',
    body: JSON.stringify({ provider: 'claude', agentId: 'build' }),
  });
  check(Boolean(session.id), 'Workbench session can be created');

  const condition = `mobile parity audit ${Date.now()}`;
  const setGoal = await requestJson('/ui/workbench/goal', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, action: 'set', condition }),
  });
  check(JSON.stringify(setGoal).includes(condition), 'Workbench goal state persists after set');

  const goalStatus = await requestJson(`/ui/workbench/goal?sessionId=${encodeURIComponent(session.id)}`);
  check(JSON.stringify(goalStatus).includes(condition), 'Workbench goal state reloads through GET');

  const clearGoal = await requestJson('/ui/workbench/goal', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, action: 'clear' }),
  });
  check(!JSON.stringify(clearGoal.goal || '').includes(condition), 'Workbench goal state clears');
}

async function main() {
  const staticResult = runStaticAudit();
  await runLiveAudit();

  if (failures.length) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    console.error(`\n${failures.length} mobile parity audit check(s) failed.`);
    process.exit(1);
  }

  console.log(`Mobile parity audit passed (${passes.length} checks).`);
  console.log(`Mode: webview-shared-web-ui; web sections: ${staticResult.webSectionCount}; web endpoint references: ${staticResult.webEndpointCount}; base URL: ${baseUrl}`);
}

main().catch((error) => {
  console.error(`Mobile parity audit failed: ${error.message}`);
  process.exit(1);
});
