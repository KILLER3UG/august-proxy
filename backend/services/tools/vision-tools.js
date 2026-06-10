/**
 * hermes-vision.js — Proxy-managed vision analysis tool.
 *
 * Backs the august__vision_analyze tool by routing through the active
 * LLM provider's vision capability or falling back to image download +
 * base64 conversion for LLM-native vision processing.
 *
 * EXPORTS:
 *   visionToolDefinitions  – Array of Zod-schema tool definitions (ToolEntry opts)
 *   tools                  – ['august__vision_analyze']
 *   registerVisionTools    – Helper to register with tool-registry
 *   visionAnalyzeHandler   – The handler function (for direct dispatch)
 *   VISION_ANALYZE_SCHEMA  – The Zod schema (for reuse)
 */

const { z } = require('zod');
const https = require('https');
const http = require('http');
const path = require('path');

// ── Constants ──

const DEFAULT_TIMEOUT = 30000;
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/svg+xml',
  'image/avif'
]);

// ── HTTP Helpers ──

/**
 * Fetch raw binary data from a URL.
 * @param {string} url
 * @param {number} timeout
 * @returns {Promise<{status: number, body: Buffer, headers: object}>}
 */
function fetchBinary(url, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const options = {
      timeout,
      headers: {
        'User-Agent': 'AugustProxy-HermesVision/1.0',
        'Accept': 'image/*'
      }
    };

    const req = protocol.get(url, options, (res) => {
      const chunks = [];
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_IMAGE_SIZE_BYTES) {
          req.destroy();
          reject(new Error(`Image exceeds maximum size of ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024} MB`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          headers: res.headers
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Fetch headers only (HEAD request) to check accessibility and content type.
 * Falls back to a GET with a very small range if HEAD is not supported.
 * @param {string} url
 * @param {number} timeout
 * @returns {Promise<{status: number, headers: object, contentType: string}>}
 */
async function checkImageAccessible(url, timeout = 10000) {
  const urlObj = new URL(url);
  const protocol = urlObj.protocol === 'https:' ? https : http;

  // Try HEAD first
  try {
    const headResult = await new Promise((resolve, reject) => {
      const options = {
        method: 'HEAD',
        timeout,
        headers: { 'User-Agent': 'AugustProxy-HermesVision/1.0' }
      };
      const req = protocol.request(url, options, (res) => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          contentType: res.headers['content-type'] || ''
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HEAD timed out')); });
      req.end();
    });

    if (headResult.status < 400) {
      return headResult;
    }
    // Fall through to GET if HEAD was rejected
  } catch (e) {
    // HEAD failed, fall through to GET
  }

  // Fallback: GET with small range to just get headers
  try {
    const getResult = await new Promise((resolve, reject) => {
      const options = {
        method: 'GET',
        timeout,
        headers: {
          'User-Agent': 'AugustProxy-HermesVision/1.0',
          Range: 'bytes=0-0'
        }
      };
      const req = protocol.request(url, options, (res) => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          contentType: res.headers['content-type'] || ''
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('GET timed out')); });
      req.end();
    });

    return getResult;
  } catch (e) {
    return { status: 0, headers: {}, contentType: '', error: e.message };
  }
}

// ── Image Processing Helpers ──

/**
 * Convert a Buffer to a base64 data URL string.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {string}
 */
function bufferToDataUrl(buffer, mimeType) {
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Normalize MIME type from content-type header or URL extension.
 * @param {string} contentType
 * @param {string} imageUrl
 * @returns {string}
 */
function normalizeMimeType(contentType, imageUrl) {
  if (contentType && SUPPORTED_IMAGE_TYPES.has(contentType.split(';')[0].trim().toLowerCase())) {
    return contentType.split(';')[0].trim().toLowerCase();
  }

  // Guess from URL extension
  const ext = path.extname(new URL(imageUrl).pathname).toLowerCase();
  const extMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif'
  };
  return extMap[ext] || 'image/jpeg';
}

/**
 * Check if a MIME type is a supported image type.
 * @param {string} mimeType
 * @returns {boolean}
 */
function isSupportedImageType(mimeType) {
  return SUPPORTED_IMAGE_TYPES.has(mimeType);
}

// ── Provider Adapter Resolution ──

/**
 * Try to get the active provider's adapter dynamically.
 * @param {object} ctx - Execution context
 * @returns {Promise<{adapter: object, providerName: string}|null>}
 */
async function resolveActiveAdapter(ctx = {}) {
  // If the context already has an adapter with analyzeImage, use it directly
  if (ctx.adapters && typeof ctx.adapters.analyzeImage === 'function') {
    return { adapter: ctx.adapters, providerName: ctx.provider || 'active' };
  }

  // Determine the active provider name
  const providerName = ctx.provider
    || (ctx.activeProvider ? ctx.activeProvider.name : null)
    || process.env.AUGUST_PROVIDER
    || 'opencode-go';

  // Try to load the adapter dynamically
  try {
    const adaptersDir = path.join(__dirname, '..', '..', 'adapters');
    const adapterPath = path.join(adaptersDir, `${providerName}.js`);
    try {
      const adapter = require(adapterPath);
      if (adapter && typeof adapter.analyzeImage === 'function') {
        return { adapter, providerName };
      }
    } catch (e) {
      // Try with -adapter suffix
      const adapterPath2 = path.join(adaptersDir, `${providerName}-adapter.js`);
      try {
        const adapter = require(adapterPath2);
        if (adapter && typeof adapter.analyzeImage === 'function') {
          return { adapter, providerName };
        }
      } catch (e2) {
        // Not found, continue to fallback
      }
    }
  } catch (e) {
    // Adapter resolution failed
  }

  return null;
}

/**
 * Try to use a vision-capable auxiliary provider (like Gemini or OpenAI)
 * for direct image analysis when the primary provider doesn't support it.
 * @param {string} imageUrl
 * @param {string} [question]
 * @param {string} [detail]
 * @returns {Promise<object|null>}
 */
async function tryAuxiliaryVisionProvider(imageUrl, question, detail) {
  // Try to find a vision-capable provider (Gemini, OpenAI, Anthropic)
  const visionProviders = ['gemini', 'openai-api', 'anthropic'];

  for (const providerName of visionProviders) {
    try {
      const { resolveProvider } = require(path.join(__dirname, '..', '..', 'providers', 'provider-resolver'));
      const provider = resolveProvider(providerName);
      if (!provider || !provider.isAvailable()) continue;

      // Fetch the image first
      const fetched = await fetchBinary(imageUrl, 15000);
      if (fetched.status >= 400) continue;

      const mimeType = normalizeMimeType(fetched.contentType, imageUrl);
      if (!mimeType || !isSupportedImageType(mimeType)) continue;

      const dataUrl = bufferToDataUrl(fetched.body, mimeType);

      // Build a chat completion request with the image
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: question || 'Describe this image in detail, including any text, objects, people, and context visible.' },
            { type: 'image_url', image_url: { url: dataUrl, detail: detail || 'auto' } }
          ]
        }
      ];

      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify({
          model: provider.model || provider.defaultModel,
          messages,
          max_tokens: 2048,
          temperature: 0.1
        }),
        signal: AbortSignal.timeout(60000)
      });

      if (!response.ok) continue;

      const result = await response.json();
      const content = result.choices?.[0]?.message?.content || '';

      return {
        provider: providerName,
        model: result.model || provider.model,
        description: content,
        usage: result.usage || null
      };
    } catch (e) {
      // Try next provider
      continue;
    }
  }

  return null;
}

// ── Zod Schema ──

const VISION_ANALYZE_SCHEMA = z.object({
  image_url: z
    .string()
    .url({ message: 'Must be a valid URL starting with http:// or https://' })
    .describe('URL of the image to analyze'),
  question: z
    .string()
    .optional()
    .describe('Optional question about the image content (e.g., "What does this chart show?")'),
  detail: z
    .enum(['low', 'high', 'auto'])
    .optional()
    .default('auto')
    .describe('Image detail level for vision processing: low (faster, less detail), high (full detail), auto (let model decide)')
});

// ── Handler ──

/**
 * Handle august__vision_analyze tool execution.
 *
 * Strategy:
 *   1. Try the active provider adapter if it has analyzeImage
 *   2. Fallback: download image → verify → base64 data URL → return for LLM-native processing
 *   3. If a question is provided, attempt to route through an auxiliary vision provider
 *
 * @param {object} args - Validated tool arguments
 * @param {object} ctx - Execution context (provider, adapters, activeProvider, etc.)
 * @returns {Promise<object>}
 */
async function visionAnalyzeHandler(args, ctx = {}) {
  const { image_url, question, detail } = args;
  const startTime = Date.now();

  // ── Step 1: Try active provider adapter's analyzeImage ──
  try {
    const resolved = await resolveActiveAdapter(ctx);
    if (resolved) {
      try {
        const result = await resolved.adapter.analyzeImage({
          image_url,
          question,
          detail: detail || 'auto'
        });
        return {
          success: true,
          image_url,
          question: question || null,
          detail: detail || 'auto',
          provider: resolved.providerName,
          method: 'provider_adapter',
          ...result,
          duration_ms: Date.now() - startTime
        };
      } catch (adapterError) {
        // Provider adapter's analyzeImage failed, fall through
        console.warn(`[HermesVision] Provider adapter analyzeImage failed: ${adapterError.message}`);
      }
    }
  } catch (e) {
    // Adapter resolution failed, continue
  }

  // ── Step 2: Download and verify image ──
  let imageInfo = {
    accessible: false,
    content_type: null,
    size_bytes: null,
    data_url: null,
    fetch_error: null
  };

  try {
    // Quick accessibility check
    const headCheck = await checkImageAccessible(image_url, 10000);
    imageInfo.accessible = headCheck.status >= 200 && headCheck.status < 400;
    imageInfo.content_type = headCheck.contentType || null;

    if (!imageInfo.accessible) {
      return {
        success: false,
        image_url,
        question: question || null,
        detail: detail || 'auto',
        accessible: false,
        content_type: imageInfo.content_type,
        error: `Image URL returned status ${headCheck.status}`,
        duration_ms: Date.now() - startTime
      };
    }

    // Full download for base64 conversion
    const fetched = await fetchBinary(image_url, 15000);
    if (fetched.status >= 400) {
      return {
        success: false,
        image_url,
        question: question || null,
        detail: detail || 'auto',
        accessible: false,
        content_type: imageInfo.content_type,
        error: `Failed to download image (HTTP ${fetched.status})`,
        duration_ms: Date.now() - startTime
      };
    }

    const mimeType = normalizeMimeType(fetched.headers['content-type'] || '', image_url);
    imageInfo.content_type = mimeType;
    imageInfo.size_bytes = fetched.body.length;

    if (!isSupportedImageType(mimeType)) {
      return {
        success: true,
        image_url,
        question: question || null,
        detail: detail || 'auto',
        accessible: true,
        content_type: mimeType,
        size_bytes: imageInfo.size_bytes,
        supported: false,
        note: `Image type "${mimeType}" may not be supported by all vision models. The URL is accessible but the format is unusual.`,
        duration_ms: Date.now() - startTime
      };
    }

    // Convert to base64 data URL for LLM processing
    const dataUrl = bufferToDataUrl(fetched.body, mimeType);
    imageInfo.data_url = dataUrl;

  } catch (fetchError) {
    imageInfo.fetch_error = fetchError.message;
  }

  // ── Step 3: If a question was asked, try auxiliary vision provider ──
  let visionResult = null;
  if (question && imageInfo.data_url) {
    try {
      visionResult = await tryAuxiliaryVisionProvider(image_url, question, detail);
    } catch (e) {
      // Auxiliary provider failed, return raw data instead
    }
  }

  // ── Build Response ──
  const response = {
    success: true,
    image_url,
    question: question || null,
    detail: detail || 'auto',
    accessible: imageInfo.accessible,
    content_type: imageInfo.content_type,
    size_bytes: imageInfo.size_bytes,
    supported: imageInfo.content_type ? isSupportedImageType(imageInfo.content_type) : false,
    duration_ms: Date.now() - startTime
  };

  // If we have a data URL, include it for LLM-native vision processing
  if (imageInfo.data_url) {
    response.data_url = imageInfo.data_url;

    const dataUrlPreviewLength = 120;
    response.data_url_preview = imageInfo.data_url.substring(0, dataUrlPreviewLength) + '...';
    response.data_url_length = imageInfo.data_url.length;

    // If the LLM supports vision natively (most modern models do),
    // the data_url will be passed as an image content part
    response.note = question
      ? 'Image data is available as a base64 data URL. The LLM can analyze it directly if it supports vision.'
      : 'Image data is available as a base64 data URL. Include it as an image_url content part in your next message to the LLM for analysis.';
  }

  // If auxiliary vision provider returned a description, include it
  if (visionResult) {
    response.description = visionResult.description;
    response.vision_provider = visionResult.provider;
    response.vision_model = visionResult.model;
    response.description_source = 'auxiliary_vision_provider';
    response.note = `Analyzed via ${visionResult.provider} (${visionResult.model || 'unknown'})`;
  }

  // Include fetch error if any
  if (imageInfo.fetch_error) {
    response.fetch_error = imageInfo.fetch_error;
  }

  return response;
}

// ── Tool Definitions (ToolEntry format for tool-registry) ──

const visionToolDefinitions = [
  {
    name: 'august__vision_analyze',
    description: 'Analyze an image at a URL with an optional question. Attempts to use the active LLM provider\'s vision capability. Falls back to downloading the image and providing it as a base64 data URL for LLM-native vision processing. Supports JPEG, PNG, GIF, WebP, BMP, TIFF, SVG, and AVIF formats.',
    schema: VISION_ANALYZE_SCHEMA,
    handler: visionAnalyzeHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'vision',
    emoji: '\u{1F441}\uFE0F',
    timeoutMs: 60000,
    requiresEnv: [],
    checkFn: null,
    metadata: {
      category: 'vision',
      source: 'vision-tools',
      provider: 'proxy-managed',
      supportsQuestion: true
    }
  }
];

const tools = ['august__vision_analyze'];

// ── Registration Helper ──

/**
 * Register vision tools with a tool registry.
 * @param {object} registry - Tool registry with registerMany() method
 */
function registerVisionTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  // Unregister stub first, then register the full implementation
  try { registry.unregister('august__vision_analyze'); } catch (_) {}
  registry.registerMany(visionToolDefinitions);
}

// ── OpenAI-format tool definition for proxy-tools pipeline ──

/**
 * Get OpenAI-format tool definitions for the proxy-tools pipeline.
 * These are injected via getProxyOpenAiToolDefinitions() to make the
 * tool visible to the LLM as a callable function.
 * @returns {Array<{type: string, function: object}>}
 */
function getVisionToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'august__vision_analyze',
        description: 'Analyze an image at a URL. Provide an optional question about the image content. Supports JPEG, PNG, GIF, WebP formats.',
        parameters: {
          type: 'object',
          properties: {
            image_url: {
              type: 'string',
              format: 'uri',
              description: 'URL of the image to analyze (http/https)'
            },
            question: {
              type: 'string',
              description: 'Optional question about the image content'
            },
            detail: {
              type: 'string',
              enum: ['low', 'high', 'auto'],
              description: 'Image detail level (default: auto)'
            }
          },
          required: ['image_url']
        }
      }
    }
  ];
}

// ── Exports ──

module.exports = {
  // Tool definitions (ToolEntry format for tool-registry)
  visionToolDefinitions,

  // Tool names
  tools,

  // Registration helper
  registerVisionTools,

  // Handler and schema (for direct use / dispatch)
  visionAnalyzeHandler,
  VISION_ANALYZE_SCHEMA,

  // OpenAI-format tool definitions (for proxy-tools pipeline)
  getVisionToolDefinitions,

  // Utility exports
  fetchBinary,
  bufferToDataUrl,
  normalizeMimeType,
  isSupportedImageType
};
