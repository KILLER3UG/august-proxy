const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { runMemoryEvals } = require('../services/memory/memory-evals');

test('memory eval fixture proves memory-on adds expected context', () => {
  const result = runMemoryEvals({
    evalFile: path.join(process.cwd(), 'evals', 'memory', 'default-cases.json'),
  });

  assert.equal(result.total, 3);
  assert.equal(result.failed, 0);
  assert.ok(result.results.every(item => item.injectedMemoryLength > 0));
});

test('memory eval fixture fails when memory is disabled', () => {
  const result = runMemoryEvals({
    evalFile: path.join(process.cwd(), 'evals', 'memory', 'default-cases.json'),
    memoryOn: false,
  });

  assert.equal(result.total, 3);
  assert.equal(result.failed, 3);
  assert.ok(result.results.every(item => item.injectedMemoryLength === 0));
});
