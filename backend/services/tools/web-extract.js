/**
 * web-extract.js — Web content extraction tool.
 * Inspired by Hermes's web_tools.py pattern.
 *
 * Fetches and extracts content from web URLs.
 * Supports multiple providers with fallback cascade.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ── Provider Configuration ──

const PROVIDERS = {
  // Free-tier providers (no API key required)
  direct: {
    name: 'direct',
    requiresApiKey: false,
    fetch: fetchDirect
  },
  // Paid providers (require API keys)
  tavily: {
    name: 'tavily',
    requiresApiKey: true,
    envKey: 'TAVILY_API_KEY',
    fetch: fetchTavily
  },
  exa: {
    name: 'exa',
    requiresApiKey: true,
    envKey: 'EXA_API_KEY',
    fetch: fetchExa
  }
};

// ── Configuration ──

function getConfig() {
  try {
    const { getConfig } = require('../../lib/config');
    const config = getConfig();
    return config.web_extract || {};
  } catch {
    return {};
  }
}

function getActiveProvider() {
  const config = getConfig();
  const preferred = config.provider || 'direct';

  // Check if preferred provider has API key if required
  const provider = PROVIDERS[preferred];
  if (provider?.requiresApiKey) {
    const envKey = provider.envKey;
    if (!process.env[envKey]) {
      // Fall back to direct
      return PROVIDERS.direct;
    }
  }

  return provider || PROVIDERS.direct;
}

// ── Direct Fetch (Free) ──

async function fetchDirect(url, options = {}) {
  const parsedUrl = new URL(url);

  return new Promise((resolve, reject) => {
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AugustBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchDirect(redirectUrl, options).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Basic HTML to text extraction
        const text = extractTextFromHtml(data);
        resolve({
          content: text,
          url: url,
          provider: 'direct',
          title: extractTitle(data)
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ── Tavily Provider ──

async function fetchTavily(url, options = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY not set');

  const response = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      urls: [url],
      extract_depth: options.depth || 'basic'
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.status}`);
  }

  const data = await response.json();
  const result = data.results?.[0];

  return {
    content: result?.raw_content || result?.content || '',
    url: url,
    provider: 'tavily',
    title: result?.title || ''
  };
}

// ── Exa Provider ──

async function fetchExa(url, options = {}) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error('EXA_API_KEY not set');

  const response = await fetch('https://api.exa.ai/contents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({
      urls: [url],
      text: true
    })
  });

  if (!response.ok) {
    throw new Error(`Exa API error: ${response.status}`);
  }

  const data = await response.json();
  const result = data.results?.[0];

  return {
    content: result?.text || '',
    url: url,
    provider: 'exa',
    title: result?.title || ''
  };
}

// ── HTML Helpers ──

function extractTextFromHtml(html) {
  // Remove script and style elements
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');

  // Convert common elements
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Clean up whitespace
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();

  return text;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

// ── Main Extract Function ──

async function extractContent(url, options = {}) {
  const provider = options.provider ? PROVIDERS[options.provider] : getActiveProvider();

  if (!provider) {
    throw new Error(`Unknown provider: ${options.provider}`);
  }

  // Check API key if required
  if (provider.requiresApiKey) {
    const envKey = provider.envKey;
    if (!process.env[envKey]) {
      throw new Error(`${envKey} not set for provider: ${provider.name}`);
    }
  }

  try {
    return await provider.fetch(url, options);
  } catch (error) {
    // If preferred provider fails, try direct as fallback
    if (provider.name !== 'direct') {
      console.warn(`[WebExtract] ${provider.name} failed, trying direct: ${error.message}`);
      return await PROVIDERS.direct.fetch(url, options);
    }
    throw error;
  }
}

// ── Search Function ──

async function searchWeb(query, options = {}) {
  const config = getConfig();
  const provider = config.search_provider || 'direct';

  if (provider === 'tavily') {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error('TAVILY_API_KEY not set');

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query,
        max_results: options.maxResults || 5,
        search_depth: options.depth || 'basic'
      })
    });

    if (!response.ok) throw new Error(`Tavily API error: ${response.status}`);

    const data = await response.json();
    return {
      results: data.results || [],
      provider: 'tavily'
    };
  }

  // Default: return empty (would need a search API)
  return {
    results: [],
    provider: 'none',
    note: 'No search provider configured. Set web_extract.search_provider in config.'
  };
}

// ── Exports ──

module.exports = {
  extractContent,
  searchWeb,
  PROVIDERS,
  getActiveProvider,
  getConfig
};
