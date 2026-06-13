const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { before, after } = require('node:test');

const envKeys = [
  'AUGUST_CORE_MEMORY_FILE',
  'AUGUST_SEMANTIC_MEMORY_FILE',
  'AUGUST_BRAIN_SQLITE_FILE',
  'AUGUST_LEARNED_GUIDELINES_FILE',
  'AUGUST_GRAPH_MEMORY_FILE',
  'AUGUST_VECTOR_DB_FILE'
];

const originals = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-memory-service-test-'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  process.env.AUGUST_CORE_MEMORY_FILE = path.join(tmpDir, 'august_core_memory.json');
  process.env.AUGUST_SEMANTIC_MEMORY_FILE = path.join(tmpDir, 'august_semantic_memory.json');
  process.env.AUGUST_BRAIN_SQLITE_FILE = path.join(tmpDir, 'august_brain.sqlite');
  process.env.AUGUST_LEARNED_GUIDELINES_FILE = path.join(tmpDir, 'august_learned_guidelines.json');
  process.env.AUGUST_GRAPH_MEMORY_FILE = path.join(tmpDir, 'august_graph_memory.json');
  process.env.AUGUST_VECTOR_DB_FILE = path.join(tmpDir, 'august_infinite_memory.json');
});

after(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeMemoryStore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const coreMemory = require('../services/memory/core-memory');
const semanticMemory = require('../services/memory/semantic-memory');
const sqliteStore = require('../services/memory/sqlite-memory-store');
const { closeMemoryStore } = sqliteStore;
const {
  buildMemorySnapshot,
  buildModelMemoryPack,
  searchBrain
} = require('../services/memory/memory-service');
const {
  createLocalEmbedding,
  saveCheckpointWithEmbedding
} = require('../services/memory/vector-db');
const {
  commitBrainEdit,
  createBrainEditProposal
} = require('../services/memory/brain-edit-service');
const {
  applyRetentionDecision,
  generateRetentionPlan,
  scoreItem
} = require('../services/memory/retention-service');
const {
  recordModelObservation
} = require('../services/memory/model-observation-service');
const {
  MEMORY_TOOLS,
  handleMemoryTool
} = require('../services/tools/memory-tools');

function parseJsonResult(result) {
  return JSON.parse(result);
}

test('sqlite memory store creates readable structured tables for facts, proposals, observations, usage, and retention', () => {
  const fact = sqliteStore.upsertMemoryFact({
    key: 'service_fact',
    value: 'service facts should be searchable and readable',
    category: 'workflow_rule',
    source: 'service-test',
    confidence: 0.92,
    metadata: { test: true }
  });
  assert.equal(fact.ok, true);

  const proposal = sqliteStore.createMemoryProposal({
    title: 'Keep service fact',
    action: 'keep_memory',
    memoryType: 'semantic',
    targetKey: 'service_fact',
    after: { key: 'service_fact', score: 92 },
    metadata: { actor: 'test' }
  });
  assert.equal(proposal.status, 'pending');

  const observation = sqliteStore.recordModelObservation({
    modelId: 'test-model',
    provider: 'test-provider',
    observationType: 'memory_scan',
    summary: 'model scan found service_fact useful',
    details: { test: true }
  });
  assert.equal(observation.ok, true);

  const usage = sqliteStore.recordMemoryUsage({
    memoryType: 'model-pack',
    targetId: 'test-model',
    metadata: { test: true }
  });
  assert.equal(usage.ok, true);

  const retention = sqliteStore.recordRetentionDecision({
    memoryType: 'semantic',
    targetKey: 'service_fact',
    score: 92,
    recommendation: 'keep',
    reasons: ['service test'],
    metadata: { proposalId: proposal.id }
  });
  assert.equal(retention.ok, true);

  const facts = sqliteStore.searchMemoryFacts('searchable', { limit: 10 });
  assert.equal(facts[0].key, 'service_fact');
  assert.ok(sqliteStore.listMemoryProposals().some(item => item.id === proposal.id));
  assert.ok(sqliteStore.listModelObservations().some(item => item.modelId === 'test-model'));
  assert.ok(sqliteStore.listMemoryUsage().some(item => item.targetId === 'test-model'));
  assert.ok(sqliteStore.listRetentionDecisions().some(item => item.targetKey === 'service_fact'));
});

test('memory-service builds snapshots, search results, and model memory packs from organized memory', () => {
  semanticMemory.setFact('snapshot_fact', 'snapshot memory pack service fact', 'workflow_rule', null, 'test', { confidence: 0.9 });
  sqliteStore.upsertMemoryFact({
    key: 'sqlite_snapshot_fact',
    value: 'sqlite snapshot memory pack service fact',
    category: 'workflow_rule',
    source: 'test',
    confidence: 0.88
  });

  const snapshot = buildMemorySnapshot({ query: 'snapshot', coreItems: 10, semanticFacts: 20, sqliteFacts: 20 });
  assert.equal(snapshot.core.file, process.env.AUGUST_CORE_MEMORY_FILE);
  assert.ok(snapshot.sqlite.facts.some(item => item.key === 'sqlite_snapshot_fact'));
  assert.ok(snapshot.semantic.facts.some(item => item.key === 'snapshot_fact'));
  assert.ok(snapshot.counts.sqliteFacts >= 1);

  const search = searchBrain('snapshot');
  assert.ok(search.results.some(item => item.provider === 'semantic' && item.key === 'snapshot_fact'));
  assert.ok(search.results.some(item => item.provider === 'sqlite-fact' && item.key === 'sqlite_snapshot_fact'));

  const pack = buildModelMemoryPack({
    modelId: 'service-pack-model',
    provider: 'test-provider',
    query: 'snapshot',
    coreItems: 10,
    semanticFacts: 20,
    sqliteFacts: 20
  });
  assert.equal(pack.model.id, 'service-pack-model');
  assert.ok(pack.semanticFacts.some(item => item.key === 'snapshot_fact'));
  assert.ok(pack.sqliteFacts.some(item => item.key === 'sqlite_snapshot_fact'));
  assert.ok(sqliteStore.listMemoryUsage().some(item => item.targetId === 'service-pack-model'));
});

test('brain-edit service creates proposals and commits approved edits safely', async () => {
  const proposal = createBrainEditProposal({
    title: 'Add committed service fact',
    description: 'Service test should commit a semantic fact after proposal review.',
    action: 'set_fact',
    memoryType: 'semantic',
    targetKey: 'committed_tool_fact',
    after: {
      key: 'committed_tool_fact',
      value: 'committed tool fact value',
      category: 'workflow_rule',
      source: 'test',
      confidence: 0.95
    },
    metadata: { actor: 'test' }
  });
  assert.equal(proposal.status, 'pending');

  const committed = commitBrainEdit(proposal.id, { actor: 'test' });
  assert.equal(committed.proposal.status, 'committed');
  assert.equal(committed.applied.action, 'set_fact');
  assert.ok(semanticMemory.searchFacts('committed tool fact value').some(item => item.key === 'committed_tool_fact'));
});

test('retention service scores candidates and records approved decisions', () => {
  const expired = scoreItem({
    title: 'old temporary fact',
    summary: 'temporary cleanup candidate',
    ttl: new Date(Date.now() - 1000).toISOString()
  });
  assert.equal(expired.recommendation, 'remove');
  assert.ok(expired.reasons.includes('ttl expired'));

  const plan = generateRetentionPlan({ query: 'service fact', limit: 30 });
  assert.ok(plan.totalCandidates >= 1);
  assert.ok(plan.items.some(item => item.targetKey === 'service_fact'));

  const fact = sqliteStore.listMemoryFacts({ limit: 10 }).find(item => item.key === 'service_fact');
  const decision = applyRetentionDecision({
    action: 'keep',
    memoryType: 'sqlite-fact',
    targetId: fact.id,
    targetKey: fact.key,
    score: 92,
    reasons: ['approved by service test'],
    actor: 'test'
  });
  assert.equal(decision.action, 'keep');
  assert.equal(decision.decision.ok, true);
  assert.ok(sqliteStore.listRetentionDecisions().some(item => item.targetKey === fact.key && item.recommendation === 'keep'));
});

test('model observation service stores observations and filters model packs', () => {
  const observation = recordModelObservation({
    modelId: 'filter-model',
    provider: 'test-provider',
    observationType: 'memory_gap',
    summary: 'model should scan service facts before proposing edits',
    details: { test: true },
    source: 'test'
  });
  assert.equal(observation.ok, true);

  const observations = sqliteStore.listModelObservations({ modelId: 'filter-model' });
  assert.ok(observations.some(item => item.summary.includes('service facts')));

  const pack = buildModelMemoryPack({
    modelId: 'filter-model',
    query: 'service',
    modelObservations: 10
  });
  assert.ok(pack.lastModelObservations.some(item => item.includes('service facts')));
});

test('memory tools expose every memory/brain tool and new tools execute against temp memory', async () => {
  const expectedTools = new Set([
    'august__memory_topics',
    'august__memory_search',
    'august__memory_read',
    'august__fact_search',
    'august__context_read',
    'august__graph_explore',
    'august__scan_brain',
    'august__memory_pack',
    'august__brain_edit',
    'august__brain_commit',
    'august__memory_retention',
    'august__memory_retention_apply',
    'august__model_observation'
  ]);
  const actualTools = new Set(MEMORY_TOOLS.map(tool => tool.function.name));
  for (const name of expectedTools) assert.ok(actualTools.has(name), `${name} should be registered`);

  const scan = parseJsonResult(await handleMemoryTool('august__scan_brain', { query: 'service' }));
  assert.ok(scan.counts.sqliteFacts >= 1);

  const pack = parseJsonResult(await handleMemoryTool('august__memory_pack', {
    modelId: 'tool-pack-model',
    provider: 'test-provider',
    query: 'service'
  }));
  assert.equal(pack.model.id, 'tool-pack-model');

  const edit = parseJsonResult(await handleMemoryTool('august__brain_edit', {
    title: 'Tool edit proposal',
    action: 'set_fact',
    memoryType: 'semantic',
    targetKey: 'tool_fact',
    after: {
      key: 'tool_fact',
      value: 'tool fact value for service tests',
      category: 'workflow_rule',
      source: 'test',
      confidence: 0.9
    },
    metadata: { actor: 'test' }
  }));
  assert.equal(edit.status, 'proposal_created');
  assert.equal(edit.proposal.status, 'pending');

  const committed = parseJsonResult(await handleMemoryTool('august__brain_commit', { proposalId: edit.proposal.id, actor: 'test' }));
  assert.equal(committed.proposal.status, 'committed');

  const retention = parseJsonResult(await handleMemoryTool('august__memory_retention', { query: 'tool fact', limit: 20 }));
  assert.ok(retention.items.some(item => item.targetKey === 'tool_fact'));

  const sqliteFact = sqliteStore.listMemoryFacts({ limit: 10 }).find(item => item.key === 'sqlite_snapshot_fact');
  const retentionApply = parseJsonResult(await handleMemoryTool('august__memory_retention_apply', {
    action: 'keep',
    memoryType: 'sqlite-fact',
    targetId: sqliteFact.id,
    targetKey: sqliteFact.key,
    score: 88,
    reasons: ['tool test keep'],
    actor: 'test'
  }));
  assert.equal(retentionApply.action, 'keep');

  const observation = parseJsonResult(await handleMemoryTool('august__model_observation', {
    modelId: 'tool-observation-model',
    provider: 'test-provider',
    observationType: 'tool_test',
    summary: 'memory tools executed against temp memory',
    details: { test: true },
    source: 'test'
  }));
  assert.equal(observation.status, 'recorded');

  assert.ok((await handleMemoryTool('august__fact_search', { query: 'tool fact value' })).includes('tool_fact'));
  assert.ok((await handleMemoryTool('august__memory_search', { query: 'tool fact value' })).includes('tool_fact'));
  assert.ok((await handleMemoryTool('august__memory_read', { key: 'tool_fact' })).includes('tool_fact'));
  assert.ok((await handleMemoryTool('august__context_read', { maxChars: 1200 })).includes('tool_fact'));
  assert.ok(typeof (await handleMemoryTool('august__graph_explore', { entityId: 'missing-test-entity' })) === 'string');
});
