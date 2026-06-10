/**
 * image-gen-tools.js — Image generation tool modules.
 * Provides local proxy-managed image generation:
 * - august__generate_image: Generate images using OpenAI DALL-E 3 API
 */

const { z } = require('zod');
const https = require('https');

// ── Configuration ──

function getOpenAIKey() {
  return process.env.OPENAI_API_KEY || process.env.AUGUST_OPENAI_KEY || '';
}

function requireOpenAI() {
  const key = getOpenAIKey();
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured. Set the OPENAI_API_KEY environment variable to use image generation tools.');
  }
  return key;
}

// ── HTTP Helper ──

function httpsPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    const options = {
      method: 'POST',
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 120000
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(postData);
    req.end();
  });
}

// ── Tool: august__generate_image ──

const GENERATE_IMAGE_SCHEMA = z.object({
  prompt: z.string().min(1).max(4000).describe('A detailed text description of the desired image'),
  size: z.enum(['1024x1024', '1792x1024', '1024x1792'])
    .optional().default('1024x1024')
    .describe('The size of the generated image'),
  quality: z.enum(['standard', 'hd'])
    .optional().default('standard')
    .describe('The quality of the image. HD costs more credits.'),
  style: z.enum(['vivid', 'natural'])
    .optional().default('vivid')
    .describe('The style of the generated image'),
  n: z.number().int().min(1).max(10)
    .optional().default(1)
    .describe('Number of images to generate (default 1, max 10)')
});

async function generateImageHandler(args, ctx = {}) {
  const { prompt, size, quality, style, n } = args;

  // Check for a provider adapter fallback first
  try {
    const provider = ctx.provider || process.env.AUGUST_PROVIDER || 'openai';
    if (ctx.adapters && typeof ctx.adapters.generateImage === 'function') {
      const result = await ctx.adapters.generateImage({ prompt, size, quality, style, n });
      return result;
    }

    // Try dynamic adapter loading
    try {
      const adaptersDir = require('path').join(__dirname, '..', '..', 'adapters');
      const providerAdapter = require(require('path').join(adaptersDir, `${provider}-adapter`));
      if (typeof providerAdapter.generateImage === 'function') {
        const result = await providerAdapter.generateImage({ prompt, size, quality, style, n });
        return result;
      }
    } catch (e) {
      // Provider adapter not available or doesn't support image generation
    }
  } catch (e) {
    // Fall through to OpenAI DALL-E
  }

  // Use OpenAI DALL-E 3
  try {
    const apiKey = requireOpenAI();

    const result = await httpsPost(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'dall-e-3',
        prompt,
        n: Math.min(n || 1, 10),
        size: size || '1024x1024',
        quality: quality || 'standard',
        style: style || 'vivid',
        response_format: 'url'
      },
      { 'Authorization': `Bearer ${apiKey}` }
    );

    if (result.status >= 400) {
      let errorMsg = `DALL-E API returned status ${result.status}`;
      try {
        const errBody = JSON.parse(result.body);
        errorMsg += `: ${errBody.error?.message || errBody.error || result.body}`;
      } catch { errorMsg += `: ${result.body.slice(0, 200)}`; }
      return { error: errorMsg };
    }

    const parsed = JSON.parse(result.body);
    const images = (parsed.data || []).map(item => ({
      url: item.url,
      revised_prompt: item.revised_prompt || null,
      b64_json: null // Not returned in URL mode
    }));

    return {
      success: true,
      prompt,
      size: size || '1024x1024',
      quality: quality || 'standard',
      style: style || 'vivid',
      created: parsed.created,
      images,
      count: images.length
    };
  } catch (e) {
    if (e.message && e.message.includes('OPENAI_API_KEY')) {
      return { error: e.message, tool_available: false };
    }
    // Try b64_json fallback if url mode failed
    try {
      const apiKey = getOpenAIKey();
      if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

      const result = await httpsPost(
        'https://api.openai.com/v1/images/generations',
        {
          model: 'dall-e-3',
          prompt,
          n: Math.min(n || 1, 10),
          size: size || '1024x1024',
          quality: quality || 'standard',
          style: style || 'vivid',
          response_format: 'b64_json'
        },
        { 'Authorization': `Bearer ${apiKey}` }
      );

      if (result.status >= 400) {
        return { error: `Image generation failed: ${e.message}` };
      }

      const parsed = JSON.parse(result.body);
      const images = (parsed.data || []).map((item, idx) => ({
        url: null,
        revised_prompt: item.revised_prompt || null,
        b64_json_available: true,
        size_hint: 'Base64 image data available in result',
        index: idx
      }));

      return {
        success: true,
        prompt,
        size: size || '1024x1024',
        quality: quality || 'standard',
        style: style || 'vivid',
        created: parsed.created,
        images,
        count: images.length,
        note: 'Images returned as base64. Use the b64_json field to embed or display.'
      };
    } catch (e2) {
      return { error: `Image generation failed: ${e2.message}` };
    }
  }
}

// ── Tool Definitions ──

const toolDefinitions = [
  {
    name: 'august__generate_image',
    description: 'Generate images using OpenAI DALL-E 3 API (or provider fallback). Accepts a text prompt and returns image URLs. Requires OPENAI_API_KEY for DALL-E fallback.',
    schema: GENERATE_IMAGE_SCHEMA,
    handler: generateImageHandler,
    permissions: { category: 'write', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F5A5}\uFE0F',
    timeoutMs: 120000,
    requiresEnv: ['OPENAI_API_KEY'],
    checkFn: () => !!getOpenAIKey(),
    metadata: { category: 'image-gen', source: 'missing-tools', provider: 'openai' }
  }
];

// ── Registration helper ──

function registerImageGenTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(toolDefinitions);
}

module.exports = {
  toolDefinitions,
  registerImageGenTools,
  generateImageHandler
};
