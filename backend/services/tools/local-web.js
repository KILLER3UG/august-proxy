// ── Local Web Tools ──
// Provides web_search and web_fetch managed tools executed locally (not sent to upstream).
// These are called by adapters when the model requests web search/fetch tool calls.
//
// Search backends (configurable via WEB_SEARCH_BACKEND env var):
//   "duckduckgo" (default) — HTML scrape, no API key needed
//   "brave"                — Brave Search API free tier (BRAVE_SEARCH_API_KEY)
//   "searxng"              — Self-hosted SearXNG instance (SEARXNG_URL)
//
// Fetch uses turndown for HTML→Markdown conversion, with Cloudflare 403 retry.

const https = require('https');
const http = require('http');
const TurndownService = require('turndown');

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// Block internal/private IP ranges
const BLOCKED_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /::1$/i,
  /^localhost$/i,
];

function isBlockedHost(hostname) {
  try {
    const normalized = hostname.replace(/:\d+$/, '');
    return BLOCKED_RANGES.some(r => r.test(normalized));
  } catch {
    return true;
  }
}

function httpsGet(url, timeout = 15000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isBlocked = isBlockedHost(urlObj.hostname);
    if (isBlocked) {
      return reject(new Error('Fetching internal/private addresses is not allowed.'));
    }
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const options = {
      timeout,
      headers: {
        'User-Agent': 'AugustProxy/1.0',
        ...extraHeaders,
      },
    };
    const req = protocol.get(url, options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

// ── Backend selection (env var, default: duckduckgo) ──
function getSearchBackend() {
  return (process.env.WEB_SEARCH_BACKEND || 'duckduckgo').toLowerCase();
}

// ── DuckDuckGo search (default, no API key needed) ──
async function duckduckgoSearch(query, maxResults) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await httpsGet(url, 15000, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
  } catch (e) {
    return { results: [], query, count: 0, note: `Search provider unavailable: ${e.message}` };
  }

  if (res.status !== 200) {
    return { results: [], query, count: 0, note: `Search provider returned status ${res.status}` };
  }

  const results = [];
  const html = res.body;
  const resultBlockRe = /<div class="result(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let blockMatch;

  while ((blockMatch = resultBlockRe.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
    const linkMatch = linkRe.exec(block);
    const snipMatch = snipRe.exec(block);
    if (!linkMatch) continue;

    let href = linkMatch[1];
    try {
      const uddg = new URL('https://html.duckduckgo.com' + href).searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    } catch { /* keep href as-is */ }

    const title = stripHtml(linkMatch[2]).trim();
    const snippet = snipMatch ? stripHtml(snipMatch[1]).trim().substring(0, 250) : '';

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  }

  if (results.length === 0) {
    return {
      results: [], query, count: 0,
      note: 'No results found — DuckDuckGo may have blocked the request or returned no hits for this query.',
    };
  }

  return { results, query, count: results.length };
}

// ── Brave Search API (free tier, requires BRAVE_SEARCH_API_KEY) ──
async function braveSearch(query, maxResults) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY environment variable is not set');

  const count = Math.min(maxResults, 20);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  let res;
  try {
    res = await httpsGet(url, 15000, {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    });
  } catch (e) {
    return { results: [], query, count: 0, note: `Brave Search unavailable: ${e.message}` };
  }

  if (res.status !== 200) {
    return { results: [], query, count: 0, note: `Brave Search returned status ${res.status}` };
  }

  let data;
  try { data = JSON.parse(res.body); } catch (e) {
    return { results: [], query, count: 0, note: 'Brave Search returned invalid JSON' };
  }

  const webResults = data.web?.results || [];
  const results = webResults.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: (item.description || '').substring(0, 300),
  }));

  return { results, query, count: results.length };
}

// ── SearXNG (self-hosted, requires SEARXNG_URL) ──
async function searxngSearch(query, maxResults) {
  const baseUrl = process.env.SEARXNG_URL;
  if (!baseUrl) throw new Error('SEARXNG_URL environment variable is not set');

  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const url = `${normalizedBase}/search?q=${encodeURIComponent(query)}&format=json&pageno=1&language=en-US`;
  let res;
  try {
    res = await httpsGet(url, 15000, {
      'Accept': 'application/json',
      'User-Agent': 'AugustProxy/1.0',
    });
  } catch (e) {
    return { results: [], query, count: 0, note: `SearXNG unavailable: ${e.message}` };
  }

  if (res.status !== 200) {
    return { results: [], query, count: 0, note: `SearXNG returned status ${res.status}` };
  }

  let data;
  try { data = JSON.parse(res.body); } catch (e) {
    return { results: [], query, count: 0, note: 'SearXNG returned invalid JSON' };
  }

  const rawResults = data.results || [];
  const results = rawResults.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: (item.content || '').substring(0, 300),
  }));

  return { results, query, count: results.length };
}

// ── web_search dispatcher ──
async function webSearch(query, maxResults = 5) {
  const backend = getSearchBackend();

  if (backend === 'brave') {
    try {
      return await braveSearch(query, maxResults);
    } catch (e) {
      console.warn(`[Web] Brave Search failed: ${e.message}. Falling back to DuckDuckGo.`);
      return await duckduckgoSearch(query, maxResults);
    }
  }

  if (backend === 'searxng') {
    try {
      return await searxngSearch(query, maxResults);
    } catch (e) {
      console.warn(`[Web] SearXNG failed: ${e.message}. Falling back to DuckDuckGo.`);
      return await duckduckgoSearch(query, maxResults);
    }
  }

  return await duckduckgoSearch(query, maxResults);
}

// ── web_fetch with turndown markdown + Cloudflare 403 retry ──
async function webFetch(url) {
  let res;
  try {
    res = await httpsGet(url);
  } catch (e) {
    throw new Error(`Fetch failed: ${e.message}`);
  }

  // Cloudflare challenge retry: if 403 with CF challenge, retry with plain UA
  if (res.status === 403 && /cf-mitigated|cf-challenge|cf-ray/i.test(res.body)) {
    console.warn(`[Web] Cloudflare challenge detected for ${url}, retrying with different UA`);
    try {
      const retryRes = await httpsGet(url, 15000, { 'User-Agent': 'AugustProxyFetch/1.0' });
      if (retryRes.status < 400) {
        res = retryRes;
      }
    } catch { /* keep original response */ }
  }

  if (res.status >= 400) throw new Error(`Fetch failed with status ${res.status}`);

  // Strip scripts, styles, and hidden elements before markdown conversion
  const cleanedHtml = res.body
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');

  const title = extractTitle(cleanedHtml);
  const rawMarkdown = turndown.turndown(cleanedHtml);
  const content = rawMarkdown.replace(/\n{3,}/g, '\n\n').substring(0, 50000).trim();

  return {
    title,
    url,
    content: content || '(no readable content)',
    status: res.status,
  };
}

// ── Normalization helpers ──
function normalizeManagedWebToolName(toolName) {
  if (toolName === 'WebSearch' || toolName === 'mcp__workspace__web_search') return 'web_search';
  if (toolName === 'WebFetch' || toolName === 'mcp__workspace__web_fetch') return 'web_fetch';
  return toolName;
}

function normalizeManagedWebArgs(toolName, args = {}) {
  const localName = normalizeManagedWebToolName(toolName);
  const normalized = { ...(args || {}) };

  if (localName === 'web_fetch') {
    if ((normalized.url === undefined || normalized.url === null || normalized.url === '') && typeof normalized.prompt === 'string') {
      normalized.url = normalized.prompt.trim();
    }
  }

  if (localName === 'web_search') {
    if ((normalized.query === undefined || normalized.query === null || normalized.query === '') && typeof normalized.prompt === 'string') {
      normalized.query = normalized.prompt.trim();
    }
  }

  return normalized;
}

// ── Managed web tool names ──
const MANAGED_WEB_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'WebSearch',
  'WebFetch',
  'mcp__workspace__web_search',
  'mcp__workspace__web_fetch',
]);

function isManagedWebToolName(name) {
  return MANAGED_WEB_TOOLS.has(name);
}

function getManagedWebToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the public web using DuckDuckGo (default), Brave Search, or SearXNG. Returns titles, URLs, and snippets.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            max_results: { type: 'number', description: 'Max results to return (default 5, max 20).' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch a public URL and convert the page to clean Markdown. Private/local network addresses are blocked. Handles Cloudflare challenges automatically.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch.' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'WebSearch',
        description: 'Search the public web using DuckDuckGo (default), Brave Search, or SearXNG. Claude-compatible alias resolved locally by the proxy.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            prompt: { type: 'string', description: 'Compatibility alias for query.' },
            max_results: { type: 'number', description: 'Max results to return (default 5, max 20).' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'WebFetch',
        description: 'Fetch a public URL and convert the page to clean Markdown. Claude-compatible alias resolved locally by the proxy. Handles Cloudflare challenges.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch.' },
            prompt: { type: 'string', description: 'Compatibility alias for url.' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mcp__workspace__web_search',
        description: 'Workspace-compatible public web search alias resolved locally by the proxy.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            prompt: { type: 'string', description: 'Compatibility alias for query.' },
            max_results: { type: 'number', description: 'Max results to return (default 5, max 20).' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mcp__workspace__web_fetch',
        description: 'Workspace-compatible public page fetch alias resolved locally by the proxy. Converts to Markdown.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch.' },
            prompt: { type: 'string', description: 'Compatibility alias for url.' },
          },
          required: ['url'],
        },
      },
    },
  ];
}

// ── Main export ──
async function executeManagedWebTool(toolName, args) {
  const localName = normalizeManagedWebToolName(toolName);
  const normalizedArgs = normalizeManagedWebArgs(localName, args);
  switch (localName) {
    case 'web_search': return webSearch(normalizedArgs.query || '', normalizedArgs.max_results || 5);
    case 'web_fetch':  return webFetch(normalizedArgs.url || '');
    default: throw new Error(`Unknown web tool: ${toolName}`);
  }
}

module.exports = { executeManagedWebTool, isManagedWebToolName, getManagedWebToolDefinitions, normalizeManagedWebToolName };
