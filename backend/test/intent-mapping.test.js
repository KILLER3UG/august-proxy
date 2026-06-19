const test = require('node:test');
const assert = require('node:assert/strict');

const { mapAugustIntent } = require('../services/august-api/intent-mapping');
const { executeAugustToolCall } = require('../services/tools/august-tools');

test('mapAugustIntent returns null for empty or non-string input', () => {
    assert.equal(mapAugustIntent(null), null);
    assert.equal(mapAugustIntent(''), null);
    assert.equal(mapAugustIntent(123), null);
});

test('mapAugustIntent matches session deletion', () => {
    const m = mapAugustIntent('Please delete the session called Project Alpha');
    assert.equal(m.tool, 'august__sessions_manage');
    assert.equal(m.action, 'delete');
});

test('mapAugustIntent matches session archive', () => {
    const m = mapAugustIntent('Archive this conversation');
    assert.equal(m.tool, 'august__sessions_manage');
    assert.equal(m.action, 'archive');
});

test('mapAugustIntent matches provider add', () => {
    const m = mapAugustIntent('Add a new provider for the OpenAI API');
    assert.equal(m.tool, 'august__providers_manage');
    assert.equal(m.action, 'upsert');
});

test('mapAugustIntent matches model change', () => {
    const m = mapAugustIntent('Change the selected model to Claude 3.5 Sonnet');
    assert.equal(m.tool, 'august__models_select');
    assert.equal(m.action, 'select');
});

test('mapAugustIntent matches settings navigation', () => {
    const m = mapAugustIntent('Open settings');
    assert.equal(m.tool, 'august__ui_control');
    assert.equal(m.action, 'navigate');
    assert.equal(m.target, '/settings');
});

test('mapAugustIntent resolves Memory & Knowledge subroute to canonical id', () => {
    const m = mapAugustIntent('Open settings and show me Memory & Knowledge');
    assert.equal(m.tool, 'august__ui_control');
    assert.equal(m.action, 'navigate');
    assert.equal(m.target, '/settings/memory-knowledge');
});

test('mapAugustIntent resolves model providers subroute', () => {
    const m = mapAugustIntent('Open settings, model providers section');
    assert.equal(m.target, '/settings/model-providers');
});

test('mapAugustIntent matches file write', () => {
    const m = mapAugustIntent('Create a file called notes.md with my draft');
    assert.equal(m.tool, 'august__filesystem_write');
    assert.equal(m.action, 'write');
});

test('mapAugustIntent matches file delete', () => {
    const m = mapAugustIntent('Delete that document please');
    assert.equal(m.tool, 'august__filesystem_delete');
    assert.equal(m.action, 'delete');
});

test('mapAugustIntent matches memory save', () => {
    const m = mapAugustIntent('Remember that I prefer dark mode');
    assert.equal(m.tool, 'august__memory_manage');
    assert.equal(m.action, 'set');
});

test('mapAugustIntent matches memory forget', () => {
    const m = mapAugustIntent('Forget that fact about the user');
    assert.equal(m.tool, 'august__memory_manage');
    assert.equal(m.action, 'delete');
});

test('mapAugustIntent matches app launch', () => {
    const m = mapAugustIntent('Launch the Chrome app');
    assert.equal(m.tool, 'august__system_process');
    assert.equal(m.action, 'start');
});

test('august__map_intent tool returns mapping', async () => {
    const r = await executeAugustToolCall('august__map_intent', { text: 'Open settings and show me Memory & Knowledge' }, false);
    assert.equal(r.ok, true);
    assert.equal(r.mapping.tool, 'august__ui_control');
    assert.equal(r.mapping.target, '/settings/memory-knowledge');
});

test('august__map_intent tool returns null mapping for unmatched text', async () => {
    const r = await executeAugustToolCall('august__map_intent', { text: 'Tell me a joke about cats' }, false);
    assert.equal(r.ok, true);
    assert.equal(r.mapping, null);
});
