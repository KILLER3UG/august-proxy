/**
 * vision-tools.js — Image analysis and vision tool modules.
 * Provides local proxy-managed vision capabilities:
 * - august__vision_analyze: Analyze an image URL with an optional question
 * - august__get_images: Extract image URLs from a web page
 */

const { z } = require('zod');
const https = require('https');
const http = require('http');

// ── Helpers ──

function httpsGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const options = { timeout, headers: { 'User-Agent': 'AugustProxy/1.0' } };
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

// ── Tool: august__vision_analyze ──

const VISION_ANALYZE_SCHEMA = z.object({
  image_url: z.string().url({ message: 'Must be a valid URL' }),
  question: z.string().optional().describe('Optional question about the image'),
  detail: z.enum(['low', 'high', 'auto']).optional().default('auto').describe('Image detail level')
});

async function visionAnalyzeHandler(args, ctx = {}) {
  const { image_url, question, detail } = args;

  // Check if the active provider's adapter has vision support
  // If the adapter exposes a vision endpoint, delegate to it
  const provider = ctx.provider || process.env.AUGUST_PROVIDER || 'openai';

  try {
    // Try to use the provider adapter's vision method if available
    if (ctx.adapters && typeof ctx.adapters.analyzeImage === 'function') {
      const result = await ctx.adapters.analyzeImage({
        image_url,
        question,
        detail
      });
      return result;
    }

    // Try to load and use the active adapter dynamically
    try {
      const adaptersDir = require('path').join(__dirname, '..', '..', 'adapters');
      const providerAdapter = require(require('path').join(adaptersDir, `${provider}-adapter`));
      if (typeof providerAdapter.analyzeImage === 'function') {
        const result = await providerAdapter.analyzeImage({ image_url, question, detail });
        return result;
      }
    } catch (e) {
      // Adapter not found or doesn't support analyzeImage
    }

    // Fallback: return the image URL info so the LLM can process it natively
    // Fetch the image to verify it's accessible and get basic metadata
    let imageInfo = { url: image_url, accessible: false };
    try {
      const res = await httpsGet(image_url, 10000);
      const contentType = res.headers['content-type'] || '';
      imageInfo.accessible = res.status === 200 && contentType.startsWith('image/');
      imageInfo.content_type = contentType;
      imageInfo.size_bytes = Buffer.byteLength(res.body, 'utf8');
    } catch (e) {
      imageInfo.error = e.message;
    }

    return {
      image_url,
      question: question || null,
      detail: detail || 'auto',
      accessible: imageInfo.accessible,
      content_type: imageInfo.content_type || null,
      size_bytes: imageInfo.size_bytes || null,
      note: imageInfo.accessible
        ? 'Image is accessible. The LLM can analyze it if it supports vision natively.'
        : 'Image could not be fetched. Check the URL and try again.',
      error: imageInfo.error || null
    };
  } catch (e) {
    return { error: `Vision analysis failed: ${e.message}`, image_url, question: question || null };
  }
}

// ── Tool: august__get_images ──

const GET_IMAGES_SCHEMA = z.object({
  url: z.string().url({ message: 'Must be a valid URL' }).describe('Page URL to extract images from'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('Maximum images to return')
});

async function getImagesHandler(args) {
  const { url, limit } = args;

  try {
    const res = await httpsGet(url, 15000);
    if (res.status >= 400) {
      return { error: `Page fetch failed with status ${res.status}`, url };
    }

    const html = res.body;
    const images = [];
    const seenUrls = new Set();

    // Match <img> tags with src attribute
    const imgRe = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = imgRe.exec(html)) !== null && images.length < limit) {
      let src = match[1].trim();
      if (!src || seenUrls.has(src)) continue;
      seenUrls.add(src);

      // Resolve relative URLs
      try {
        src = new URL(src, url).href;
      } catch {
        continue;
      }

      // Extract alt text if available
      const altMatch = match[0].match(/alt\s*=\s*["']([^"']*)["']/i);
      const alt = altMatch ? altMatch[1] : '';

      images.push({ src, alt, index: images.length });
    }

    // Also look for srcset images
    const srcsetRe = /<img[^>]+srcset\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while ((match = srcsetRe.exec(html)) !== null && images.length < limit) {
      const srcset = match[1];
      const urls = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
      for (const u of urls) {
        if (images.length >= limit) break;
        if (seenUrls.has(u)) continue;
        seenUrls.add(u);
        try {
          const resolved = new URL(u, url).href;
          images.push({ src: resolved, alt: '', index: images.length, from_srcset: true });
        } catch { /* skip invalid */ }
      }
    }

    return {
      url,
      count: images.length,
      images: images.slice(0, limit),
      page_title: extractTitle(html) || ''
    };
  } catch (e) {
    return { error: `Failed to extract images: ${e.message}`, url };
  }
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

// ── Tool Definitions (Zod-schema format for tool-registry) ──

const toolDefinitions = [
  {
    name: 'august__vision_analyze',
    description: 'Analyze an image at a URL with an optional question. Uses vision model if available, otherwise returns image metadata for LLM-native vision processing.',
    schema: VISION_ANALYZE_SCHEMA,
    handler: visionAnalyzeHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F441}\uFE0F',
    timeoutMs: 45000,
    requiresEnv: [],
    metadata: { category: 'vision', source: 'missing-tools' }
  },
  {
    name: 'august__get_images',
    description: 'Extract image URLs from a web page by parsing the HTML. Returns all image sources found in img tags and srcset attributes.',
    schema: GET_IMAGES_SCHEMA,
    handler: getImagesHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F5BC}\uFE0F',
    timeoutMs: 30000,
    requiresEnv: [],
    metadata: { category: 'vision', source: 'missing-tools' }
  }
];

// ── Registration helper ──

function registerVisionTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(toolDefinitions);
}

module.exports = {
  toolDefinitions,
  registerVisionTools,
  visionAnalyzeHandler,
  getImagesHandler
};
