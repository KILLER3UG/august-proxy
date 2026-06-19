const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AUGUST_REMINDER,
} = require('../adapters/anthropic');
const {
  isPlanModeBlocked,
  normalizeGuardMode,
  requireApproval,
} = require('../services/workbench/workbench');

function mockSession(overrides = {}) {
  return {
    id: 'test-session',
    provider: 'claude',
    agentId: 'build',
    guardMode: 'plan',
    plan: null,
    approved: false,
    messages: [],
    mutationLog: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('Plan Mode blocks mutating tools', () => {
  const session = mockSession({ guardMode: 'plan' });
  const blocked = requireApproval(session, 'august__write_file', { path: 'test.txt', content: 'x' });

  assert.equal(blocked.blocked, true);
  assert.equal(blocked.type, 'plan_mode_guard');
  assert.match(blocked.message, /Plan Mode is active/);
});

test('Plan Mode blocks shell commands and install-like tools', () => {
  assert.equal(isPlanModeBlocked('august__run_command', { command: 'npm install left-pad' }), true);
  assert.equal(isPlanModeBlocked('august__import_skill', { url: 'https://example.invalid/skill' }), true);
  assert.equal(isPlanModeBlocked('august__list_directory', { path: '.' }), false);
});

test('Ask Mode returns a confirmation token for mutations', () => {
  const session = mockSession({ guardMode: 'ask' });
  const blocked = requireApproval(session, 'august__write_file', { path: 'test.txt', content: 'x' });

  assert.equal(blocked.blocked, true);
  assert.equal(blocked.type, 'mutation_pending_confirmation');
  assert.match(blocked.confirmationToken, /^confirm_/);
});

test('Ask Mode approved mutation bypasses the confirmation gate', () => {
  const session = mockSession({ guardMode: 'ask' });
  assert.equal(requireApproval(session, 'august__write_file', { path: 'test.txt', content: 'x' }, { approvedMutation: true }), null);
});

test('Full Access bypasses approval for build-agent mutations', () => {
  const session = mockSession({ guardMode: 'full' });
  assert.equal(requireApproval(session, 'august__write_file', { path: 'test.txt', content: 'x' }), null);
});

test('Guard mode normalization defaults invalid values to plan', () => {
  assert.equal(normalizeGuardMode('FULL'), 'full');
  assert.equal(normalizeGuardMode('unknown'), 'plan');
  assert.equal(normalizeGuardMode(null), 'plan');
});

test('Workbench hard-rule prompt source contains Plan Mode concrete-plan instruction', () => {
  const fs = require('node:fs');
  const promptSource = fs.readFileSync(require.resolve('../services/workbench/workbench.js'), 'utf8');

  assert.match(promptSource, /In Plan Mode, always present a concrete plan/);
  assert.match(promptSource, /objective, steps, risks or blockers, and verification/);
});

test('AUGUST reminder avoids persona-style honorific behavior', () => {
  assert.equal(AUGUST_REMINDER.content.includes('Sir'), false);
  assert.equal(AUGUST_REMINDER.content.includes('Done, Sir'), false);
  assert.match(AUGUST_REMINDER.content, /professional contract/);
});
