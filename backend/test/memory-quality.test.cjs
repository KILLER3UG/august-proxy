const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { before, after } = require('node:test');
const { decorateMemoryQuality, normalizeProvenance, scoreMemoryQuality } = require('../services/memory/memory-quality');
const { deleteFact, setFact, searchFacts } = require('../services/memory/semantic-memory');

const originalSemanticFile = process.env.AUGUST_SEMANTIC_MEMORY_FILE;
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-quality-test-'));
  process.env.AUGUST_SEMANTIC_MEMORY_FILE = path.join(tmpDir, 'august_semantic_memory.json');
});

after(() => {
  if (originalSemanticFile === undefined) {
    delete process.env.AUGUST_SEMANTIC_MEMORY_FILE;
  } else {
    process.env.AUGUST_SEMANTIC_MEMORY_FILE = originalSemanticFile;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('semantic facts keep provenance and quality metadata', () => {
  const fact = setFact('local_shell_preference', 'Use git-bash POSIX shell syntax.', 'workflow_rule', null, 'test-session', {
    sourceSessionId: 'session_1',
    sourceMessageId: 'msg_1',
    sourceType: 'manual',
    confidence: 0.9,
  });

  assert.equal(fact.source, 'test-session');
  assert.equal(fact.provenance.sourceSessionId, 'session_1');
  assert.equal(fact.provenance.sourceMessageId, 'msg_1');
  assert.equal(fact.provenance.sourceType, 'manual');
  assert.equal(fact.confidence, 0.9);

  const [result] = searchFacts('git-bash');
  assert.equal(result.key, 'local_shell_preference');
  assert.equal(result.provenance.sourceSessionId, 'session_1');
});

test('setFact honors options.source when positional source is null', () => {
  const fact = setFact('auto_source_fact', 'Options source should win when source arg is null.', 'workflow_rule', null, null, {
    source: 'auto',
  });

  assert.equal(fact.source, 'auto');
  assert.equal(fact.provenance.source, 'auto');
  deleteFact('auto_source_fact');
});

test('semantic memory creates parent directories for env path', () => {
  const nestedFile = path.join(tmpDir, 'nested', 'deep', 'august_semantic_memory.json');
  const previous = process.env.AUGUST_SEMANTIC_MEMORY_FILE;
  process.env.AUGUST_SEMANTIC_MEMORY_FILE = nestedFile;

  try {
    const fact = setFact('nested_path_fact', 'The parent directory should be created.', 'workflow_rule');
    assert.equal(fact.key, 'nested_path_fact');
    assert.ok(fs.existsSync(nestedFile));
  } finally {
    if (previous === undefined) {
      delete process.env.AUGUST_SEMANTIC_MEMORY_FILE;
    } else {
      process.env.AUGUST_SEMANTIC_MEMORY_FILE = previous;
    }
  }
});

test('memory quality scorer labels high-confidence workflow memory as high', () => {
  const item = decorateMemoryQuality({
    title: 'Shell preference',
    summary: 'Use git-bash POSIX shell syntax for terminal commands.',
    confidence: 0.9,
    pinned: true,
  });

  assert.equal(item.quality.label, 'high');
  assert.equal(item.provenance.confidence, 0.9);
});

test('provenance normalizes legacy memory metadata', () => {
  const provenance = normalizeProvenance({
    source: 'auto-memory',
    sourceSessionId: 'session_2',
    confidence: 1.2,
    pinned: true,
  });

  assert.equal(provenance.source, 'auto-memory');
  assert.equal(provenance.sourceSessionId, 'session_2');
  assert.equal(provenance.confidence, 1);
  assert.equal(provenance.pinned, true);
});

test('scoreMemoryQuality flags expired memory', () => {
  const quality = scoreMemoryQuality({
    title: 'Old temporary fact',
    summary: 'This is a temporary debugging note.',
    ttl: new Date(Date.now() - 1000).toISOString(),
  });

  assert.equal(quality.label, 'review');
  assert.ok(quality.reasons.includes('expired'));
});
