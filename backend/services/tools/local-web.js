// ── Local Web Tools ──
// Provides web_search and web_fetch managed tools executed locally (not sent to upstream).
// These are called by adapters when the model requests web search/fetch tool calls.

const https = require('https');
const http = require('http');

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
    const normalized = hostname.replace(/:\d+$/, ''); // strip port
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
        ...extraHeaders
      }
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

// ── web_search ──
async function webSearch(query, maxResults = 5) {
  // html.duckduckgo.com/html/ is the static page that returns real web results.
  // api.duckduckgo.com only returns Instant Answers (topic summaries) which are
  // almost always empty for general queries.
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await httpsGet(url, 15000, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    });
  } catch (e) {
    return {
      results: [],
      query,
      count: 0,
      note: `Search provider unavailable: ${e.message}`
    };
  }

  if (res.status !== 200) {
    return {
      results: [],
      query,
      count: 0,
      note: `Search provider returned status ${res.status}`
    };
  }

  const results = [];
  const html = res.body;

  // Each result lives inside <div class="result ...">...</div>
  // We match lazily up to the closing </div></div> pair.
  const resultBlockRe = /<div class="result(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let blockMatch;

  while ((blockMatch = resultBlockRe.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];

    // Title link: <a class="result__a" href="/l/?uddg=...&...">Title text</a>
    const linkRe   = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    // Snippet:    <a class="result__snippet">snippet text</a>
    const snipRe   = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;

    const linkMatch = linkRe.exec(block);
    const snipMatch = snipRe.exec(block);
    if (!linkMatch) continue;

    // DuckDuckGo wraps the real URL in a redirect — extract via uddg param
    let href = linkMatch[1];
    try {
      const uddg = new URL('https://html.duckduckgo.com' + href).searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    } catch { /* keep href as-is if URL parsing fails */ }

    const title   = stripHtml(linkMatch[2]).trim();
    const snippet = snipMatch ? stripHtml(snipMatch[1]).trim().substring(0, 250) : '';

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  }

  if (results.length === 0) {
    return {
      results: [], query, count: 0,
      note: 'No results found — DuckDuckGo may have blocked the request or returned no hits for this query.'
    };
  }

  return { results, query, count: results.length };
}

// ── web_fetch ──
async function webFetch(url) {
  const res = await httpsGet(url);
  if (res.status >= 400) throw new Error(`Fetch failed with status ${res.status}`);

  const content = stripHtml(res.body).substring(0, 4000);
  const title = extractTitle(res.body) || url;
  const textContent = content.length > 0 ? content : '(no readable text content)';

  return { title, url, content: textContent, status: res.status };
}

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
  'mcp__workspace__web_fetch'
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
        description: 'Search the public web using DuckDuckGo. Returns titles, URLs, and snippets.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            max_results: { type: 'number', description: 'Max results to return (default 5, max 10).' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch and extract readable text content from a public URL.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch.' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'WebSearch',
        description: 'Search the public web using DuckDuckGo. Claude-compatible alias resolved locally by the proxy.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            prompt: { type: 'string', description: 'Compatibility alias for query.' },
            max_results: { type: 'number', description: 'Max results to return (default 5, max 10).' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'WebFetch',
        description: 'Fetch and extract readable text from a public URL. Claude-compatible alias resolved locally by the proxy.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch.' },
            prompt: { type: 'string', description: 'Compatibility alias for url.' }
          },
          required: ['url']
        }
      }
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
            max_results: { type: 'number', description: 'Max results to return (default 5, max 10).' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mcp__workspace__web_fetch',
        description: 'Workspace-compatible public page fetch alias resolved locally by the proxy.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch.' },
            prompt: { type: 'string', description: 'Compatibility alias for url.' }
          },
          required: ['url']
        }
      }
    }
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
