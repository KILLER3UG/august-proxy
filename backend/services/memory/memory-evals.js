const fs = require('fs');
const path = require('path');
const { buildSystemPromptText } = require('./context-builder');

function defaultEvalDir() {
  return path.join(process.cwd(), 'evals', 'memory');
}

function ensureEvalDir() {
  fs.mkdirSync(defaultEvalDir(), { recursive: true });
}

function defaultEvalFile() {
  return path.join(defaultEvalDir(), 'default-cases.json');
}

function listMemoryEvals(evalDir = defaultEvalDir()) {
  ensureEvalDir();
  return fs.readdirSync(evalDir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => path.join(evalDir, file));
}

function normalizeEvalCase(inputCase) {
  const testCase = { ...inputCase };
  testCase.id = String(testCase.id || 'untitled');
  testCase.description = String(testCase.description || '');
  testCase.originalSystem = testCase.originalSystem || 'You are a helpful assistant.';
  testCase.expectedTokens = Array.isArray(testCase.expectedTokens) ? testCase.expectedTokens : [];
  testCase.expectedMinimum = Number.isFinite(Number(testCase.expectedMinimum))
    ? Number(testCase.expectedMinimum)
    : Math.max(1, Math.min(3, testCase.expectedTokens.length));
  testCase.memory = testCase.memory || {};
  testCase.options = testCase.options || {};
  return testCase;
}

function countExpectedTokens(text, expectedTokens = []) {
  return expectedTokens
    .map(token => ({ token, found: String(text || '').includes(token) }))
    .filter(item => item.found);
}

function scoreEvalCase(testCase, { memoryOn = true, memoryOff = {} } = {}) {
  const normalized = normalizeEvalCase(testCase);
  const offOptions = {
    ...normalized.options,
    memory: memoryOff,
    includeProxyContext: false,
    includeOriginalSystem: true,
  };
  const onOptions = {
    ...normalized.options,
    memory: normalized.memory,
    includeProxyContext: memoryOn,
    includeOriginalSystem: true,
  };

  const offPrompt = buildSystemPromptText(normalized.originalSystem, offOptions);
  const onPrompt = buildSystemPromptText(normalized.originalSystem, onOptions);
  const offMatches = countExpectedTokens(offPrompt, normalized.expectedTokens);
  const onMatches = countExpectedTokens(onPrompt, normalized.expectedTokens);

  return {
    id: normalized.id,
    description: normalized.description,
    expectedTokens: normalized.expectedTokens,
    expectedMinimum: normalized.expectedMinimum,
    memoryOn: Boolean(memoryOn),
    promptLength: {
      memoryOff: offPrompt.length,
      memoryOn: onPrompt.length,
    },
    injectedMemoryLength: Math.max(0, onPrompt.length - offPrompt.length),
    matches: {
      memoryOff: offMatches.map(item => item.token),
      memoryOn: onMatches.map(item => item.token),
    },
    matchCounts: {
      memoryOff: offMatches.length,
      memoryOn: onMatches.length,
    },
    passed: onMatches.length >= normalized.expectedMinimum && onMatches.length > offMatches.length,
  };
}

function loadMemoryEvalCases(options = {}) {
  const evalDir = options.evalDir || defaultEvalDir();
  const evalFile = options.evalFile || defaultEvalFile();

  if (options.name) {
    const namedFile = path.join(evalDir, `${options.name}.json`);
    const exists = fs.existsSync(namedFile);
    if (!exists) throw new Error(`memory eval file not found: ${namedFile}`);
    const parsed = JSON.parse(fs.readFileSync(namedFile, 'utf8'));
    return Array.isArray(parsed) ? parsed.map(normalizeEvalCase) : [normalizeEvalCase(parsed)];
  }

  const parsed = JSON.parse(fs.readFileSync(evalFile, 'utf8'));
  return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeEvalCase);
}

function runMemoryEvals(options = {}) {
  const cases = loadMemoryEvalCases(options);
  const results = cases.map(testCase => scoreEvalCase(testCase, options));
  const passed = results.filter(result => result.passed);
  const failed = results.filter(result => !result.passed);

  return {
    ok: failed.length === 0,
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    results,
    summary: {
      passedIds: passed.map(result => result.id),
      failedIds: failed.map(result => result.id),
      totalPromptLength: results.reduce((sum, result) => sum + result.promptLength.memoryOn, 0),
      totalInjectedMemoryLength: results.reduce((sum, result) => sum + result.injectedMemoryLength, 0),
    },
  };
}

module.exports = {
  countExpectedTokens,
  defaultEvalDir,
  defaultEvalFile,
  ensureEvalDir,
  listMemoryEvals,
  loadMemoryEvalCases,
  normalizeEvalCase,
  runMemoryEvals,
  scoreEvalCase,
};
