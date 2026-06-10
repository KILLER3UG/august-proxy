/**
 * audio-tools.js — Text-to-Speech and Speech-to-Text tool modules.
 * Provides local proxy-managed audio capabilities:
 * - august__text_to_speech: Convert text to speech audio via OpenAI TTS API
 * - august__speech_to_text: Transcribe audio to text via OpenAI Whisper API
 */

const { z } = require('zod');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Configuration ──

function getOpenAIKey() {
  return process.env.OPENAI_API_KEY || process.env.AUGUST_OPENAI_KEY || '';
}

function requireOpenAI() {
  const key = getOpenAIKey();
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured. Set the OPENAI_API_KEY environment variable to use audio tools.');
  }
  return key;
}

// ── HTTP Helpers ──

function httpsPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = typeof data === 'string' ? data : JSON.stringify(data);
    const isJson = typeof data === 'object' && !(data instanceof Buffer);
    const options = {
      method: 'POST',
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      port: urlObj.port || 443,
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 60000
    };
    if (isJson) options.headers['Content-Type'] = 'application/json';

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

function httpsDownload(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const chunks = [];
    const req = protocol.get(url, { timeout: 30000 }, res => {
      if (res.statusCode >= 400) {
        reject(new Error(`Download failed with status ${res.statusCode}`));
        return;
      }
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

// ── Tool: august__text_to_speech ──

const TTS_SCHEMA = z.object({
  text: z.string().min(1).max(4096).describe('The text to convert to speech'),
  voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
    .optional().default('alloy')
    .describe('The voice to use for speech synthesis'),
  output_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'])
    .optional().default('mp3')
    .describe('The audio output format')
});

async function textToSpeechHandler(args) {
  const { text, voice, output_format } = args;

  try {
    const apiKey = requireOpenAI();

    // Determine output format via query parameter for OpenAI TTS
    const responseFormat = output_format === 'mp3' ? 'mp3' : output_format;

    const result = await httpsPost(
      'https://api.openai.com/v1/audio/speech',
      {
        model: 'tts-1',
        input: text,
        voice: voice,
        response_format: responseFormat
      },
      {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    );

    if (result.status >= 400) {
      let errorMsg = `TTS API returned status ${result.status}`;
      try {
        const errBody = JSON.parse(result.body);
        errorMsg += `: ${errBody.error?.message || errBody.error || result.body}`;
      } catch { errorMsg += `: ${result.body.slice(0, 200)}`; }
      return { error: errorMsg };
    }

    // Save the audio to a temp file
    const tmpDir = path.join(os.tmpdir(), 'august-tts');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `tts_${Date.now()}.${output_format || 'mp3'}`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, result.body, 'binary');

    return {
      success: true,
      text,
      voice,
      format: output_format || 'mp3',
      filepath,
      filename,
      size_bytes: Buffer.byteLength(result.body, 'binary'),
      note: 'Audio file saved. Use the filepath to access or play the audio.'
    };
  } catch (e) {
    if (e.message.includes('OPENAI_API_KEY')) {
      return { error: e.message, tool_available: false };
    }
    return { error: `Text-to-speech failed: ${e.message}` };
  }
}

// ── Tool: august__speech_to_text ──

const STT_SCHEMA = z.object({
  audio_url: z.string().url({ message: 'Must be a valid URL' }).describe('URL of the audio file to transcribe'),
  language: z.string().optional().describe('Optional language code (e.g., "en", "fr", "es") to improve accuracy')
});

async function speechToTextHandler(args) {
  const { audio_url, language } = args;

  try {
    const apiKey = requireOpenAI();

    // Download the audio file
    let audioBuffer;
    try {
      audioBuffer = await httpsDownload(audio_url);
    } catch (e) {
      return { error: `Failed to download audio from URL: ${e.message}` };
    }

    if (audioBuffer.length === 0) {
      return { error: 'Downloaded audio file is empty' };
    }

    if (audioBuffer.length > 25 * 1024 * 1024) {
      return { error: 'Audio file exceeds 25MB limit for Whisper API' };
    }

    // Save to temp file for sending to API
    const tmpDir = path.join(os.tmpdir(), 'august-stt');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // Infer extension from URL or default to .mp3
    const urlExt = path.extname(new URL(audio_url).pathname) || '.mp3';
    const filename = `stt_${Date.now()}${urlExt}`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, audioBuffer);

    // Create multipart form data for OpenAI Whisper API
    const boundary = '---AugustFormBoundary' + Math.random().toString(36).slice(2);

    // Build multipart body manually
    const CRLF = '\r\n';
    const parts = [];

    // Model field
    parts.push(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
      'whisper-1'
    );

    // File field
    parts.push(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
      `Content-Type: audio/${urlExt.replace('.', '')}${CRLF}${CRLF}`
    );

    // Language (optional)
    if (language) {
      parts.push(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
        language
      );
    }

    // Closing boundary
    parts.push(`${CRLF}--${boundary}--${CRLF}`);

    // Build the body with file content
    let bodyParts = [];
    for (let i = 0; i < parts.length; i++) {
      if (i === 1) {
        // This is the file header part
        bodyParts.push(Buffer.from(parts[i]));
        bodyParts.push(audioBuffer);
      } else {
        bodyParts.push(Buffer.from(parts[i]));
      }
    }

    const fullBody = Buffer.concat(bodyParts);

    // Send to OpenAI
    const urlObj = new URL('https://api.openai.com/v1/audio/transcriptions');
    const result = await new Promise((resolve, reject) => {
      const options = {
        method: 'POST',
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': fullBody.length
        },
        timeout: 120000
      };

      const req = https.request(options, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.write(fullBody);
      req.end();
    });

    // Cleanup temp file
    try { fs.unlinkSync(filepath); } catch { /* ignore */ }

    if (result.status >= 400) {
      let errorMsg = `Whisper API returned status ${result.status}`;
      try {
        const errBody = JSON.parse(result.body);
        errorMsg += `: ${errBody.error?.message || errBody.error || result.body}`;
      } catch { errorMsg += `: ${result.body.slice(0, 200)}`; }
      return { error: errorMsg, audio_url };
    }

    const parsed = JSON.parse(result.body);
    return {
      success: true,
      text: parsed.text || '',
      language: language || 'detected',
      duration_seconds: parsed.duration || null,
      audio_url,
      segments: parsed.segments || []
    };
  } catch (e) {
    if (e.message.includes('OPENAI_API_KEY')) {
      return { error: e.message, tool_available: false };
    }
    return { error: `Speech-to-text failed: ${e.message}` };
  }
}

// ── Tool Definitions ──

const toolDefinitions = [
  {
    name: 'august__text_to_speech',
    description: 'Convert text to speech audio using OpenAI TTS API. Requires OPENAI_API_KEY to be configured. Returns a link to the generated audio file.',
    schema: TTS_SCHEMA,
    handler: textToSpeechHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F399}\uFE0F',
    timeoutMs: 60000,
    requiresEnv: ['OPENAI_API_KEY'],
    checkFn: () => !!getOpenAIKey(),
    metadata: { category: 'audio', source: 'missing-tools', provider: 'openai' }
  },
  {
    name: 'august__speech_to_text',
    description: 'Transcribe audio to text using OpenAI Whisper API. Requires OPENAI_API_KEY to be configured. Accepts audio file URLs (mp3, wav, etc., max 25MB).',
    schema: STT_SCHEMA,
    handler: speechToTextHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F3A4}',
    timeoutMs: 120000,
    requiresEnv: ['OPENAI_API_KEY'],
    checkFn: () => !!getOpenAIKey(),
    metadata: { category: 'audio', source: 'missing-tools', provider: 'openai' }
  }
];

// ── Registration helper ──

function registerAudioTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(toolDefinitions);
}

module.exports = {
  toolDefinitions,
  registerAudioTools,
  textToSpeechHandler,
  speechToTextHandler
};
