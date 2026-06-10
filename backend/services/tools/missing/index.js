/**
 * index.js — Aggregator for missing tool modules.
 * Imports all missing tool definitions and provides a single
 * registerMissingTools() function that registers all tools
 * with the tool-registry.
 *
 * Usage:
 *   const { registerMissingTools } = require('./missing');
 *   const toolRegistry = require('../tool-registry');
 *   registerMissingTools(toolRegistry);
 */

const path = require('path');

// Lazy-load all tool modules to avoid circular deps
let _visionTools = null;
let _audioTools = null;
let _imageGenTools = null;
let _cronTools = null;
let _sessionTools = null;
let _codeReviewTools = null;

function loadModule(name) {
  try {
    return require(path.join(__dirname, name));
  } catch (e) {
    console.warn(`[MissingTools] Could not load ${name}: ${e.message}`);
    return null;
  }
}

function ensureVisionTools() {
  if (!_visionTools) _visionTools = loadModule('vision-tools');
  return _visionTools;
}

function ensureAudioTools() {
  if (!_audioTools) _audioTools = loadModule('audio-tools');
  return _audioTools;
}

function ensureImageGenTools() {
  if (!_imageGenTools) _imageGenTools = loadModule('image-gen-tools');
  return _imageGenTools;
}

function ensureCronTools() {
  if (!_cronTools) _cronTools = loadModule('cron-tools');
  return _cronTools;
}

function ensureSessionTools() {
  if (!_sessionTools) _sessionTools = loadModule('session-tools');
  return _sessionTools;
}

function ensureCodeReviewTools() {
  if (!_codeReviewTools) _codeReviewTools = loadModule('code-review-tools');
  return _codeReviewTools;
}

// ── Combined Tool Definitions ──

function getAllToolDefinitions() {
  const all = [];

  const vision = ensureVisionTools();
  if (vision && vision.toolDefinitions) all.push(...vision.toolDefinitions);

  const audio = ensureAudioTools();
  if (audio && audio.toolDefinitions) all.push(...audio.toolDefinitions);

  const imageGen = ensureImageGenTools();
  if (imageGen && imageGen.toolDefinitions) all.push(...imageGen.toolDefinitions);

  const cron = ensureCronTools();
  if (cron && cron.toolDefinitions) all.push(...cron.toolDefinitions);

  const session = ensureSessionTools();
  if (session && session.toolDefinitions) all.push(...session.toolDefinitions);

  const codeReview = ensureCodeReviewTools();
  if (codeReview && codeReview.toolDefinitions) all.push(...codeReview.toolDefinitions);

  return all;
}

// ── Registration ──

function registerMissingTools(registry) {
  if (!registry) {
    throw new Error('A tool registry is required. Pass the tool-registry module (or an object with registerMany()).');
  }

  const registryObj = registry.registerMany ? registry : require(require('path').join(__dirname, '..', 'tool-registry'));

  const modules = [
    { name: 'vision-tools', loader: ensureVisionTools },
    { name: 'audio-tools', loader: ensureAudioTools },
    { name: 'image-gen-tools', loader: ensureImageGenTools },
    { name: 'cron-tools', loader: ensureCronTools },
    { name: 'session-tools', loader: ensureSessionTools },
    { name: 'code-review-tools', loader: ensureCodeReviewTools }
  ];

  let totalRegistered = 0;
  const errors = [];

  // Map of module names to their register functions
  const registerFnMap = {
    'vision-tools': 'registerVisionTools',
    'audio-tools': 'registerAudioTools',
    'image-gen-tools': 'registerImageGenTools',
    'cron-tools': 'registerCronTools',
    'session-tools': 'registerSessionTools',
    'code-review-tools': 'registerCodeReviewTools'
  };

  for (const mod of modules) {
    try {
      const loaded = mod.loader();
      if (loaded && loaded.toolDefinitions && loaded.toolDefinitions.length > 0) {
        const registerFnName = registerFnMap[mod.name];
        const registerFn = registerFnName ? loaded[registerFnName] : null;

        if (typeof registerFn === 'function') {
          registerFn(registryObj);
        } else {
          // Fallback: register directly via registry.registerMany
          registryObj.registerMany(loaded.toolDefinitions);
        }
        totalRegistered += loaded.toolDefinitions.length;
      }
    } catch (e) {
      errors.push(`${mod.name}: ${e.message}`);
    }
  }

  return {
    registered: totalRegistered,
    errors: errors.length > 0 ? errors : undefined,
    success: errors.length === 0
  };
}

// ── Start Cron Scheduler ──

function startCronScheduler() {
  const cron = ensureCronTools();
  if (cron && typeof cron.startCronScheduler === 'function') {
    return cron.startCronScheduler();
  }
  console.warn('[MissingTools] Cron tools not available, scheduler not started.');
  return false;
}

function stopCronScheduler() {
  const cron = ensureCronTools();
  if (cron && typeof cron.stopCronScheduler === 'function') {
    return cron.stopCronScheduler();
  }
  return false;
}

// ── Exports ──

module.exports = {
  registerMissingTools,
  getAllToolDefinitions,
  startCronScheduler,
  stopCronScheduler,
  // Direct access to individual module loaders
  ensureVisionTools,
  ensureAudioTools,
  ensureImageGenTools,
  ensureCronTools,
  ensureSessionTools,
  ensureCodeReviewTools
};
