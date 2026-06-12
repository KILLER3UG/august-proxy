const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-memory-test-'));
process.env.AUGUST_CORE_MEMORY_FILE = path.join(tmpDir, 'august_core_memory.json');
process.env.AUGUST_LEARNING_HISTORY_FILE = path.join(tmpDir, 'august_learning_history.json');

const {
  checkMemoryBudget,
  CoreMemoryBudgetError,
  readAugustCoreMemory,
  writeAugustCoreMemory
} = require('../services/memory/core-memory');
const { executeAugustToolCall } = require('../services/tools/august-tools');
const { getLearningStatus } = require('../services/memory/auto-memory');

async function main() {
  const defaultMemory = readAugustCoreMemory();
  writeAugustCoreMemory(defaultMemory);

  assert.deepStrictEqual(checkMemoryBudget('global_context', 'x'.repeat(4000)), {
    valid: true,
    length: 4000,
    limit: 4000,
    overage: 0
  });

  assert.deepStrictEqual(checkMemoryBudget('user_profile', 'x'.repeat(3001)), {
    valid: false,
    length: 3001,
    limit: 3000,
    overage: 1
  });

  const appendResult = await executeAugustToolCall('august__core_memory_append', {
    section: 'global_context',
    content: 'small append under budget'
  });
  const appendText = String(appendResult);
  assert(!appendText.includes('[Tool Execution Failed]'), appendText);
  assert(readAugustCoreMemory().global_context.includes('small append under budget'));

  const replaceResult = await executeAugustToolCall('august__core_memory_replace', {
    section: 'global_context',
    content: 'x'.repeat(4001)
  });
  const replaceText = String(replaceResult);
  assert(replaceText.includes('over the 4000 character limit'), replaceText);
  assert(!readAugustCoreMemory().global_context.startsWith('xxx'));

  assert.throws(() => {
    writeAugustCoreMemory({
      ...readAugustCoreMemory(),
      global_context: 'x'.repeat(4001)
    });
  }, CoreMemoryBudgetError);

  const status = getLearningStatus();
  assert.strictEqual(status.status, 'idle');
  assert(Array.isArray(status.history));

  console.log('memory budget and learning status tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
