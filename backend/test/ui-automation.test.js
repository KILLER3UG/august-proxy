const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    createUiEvent,
    listUiEvents,
    validateUiAction,
    VALID_UI_ACTIONS,
    UI_EVENTS_PATH
} = require('../services/ui/ui-automation');

function clearEvents() {
    if (fs.existsSync(UI_EVENTS_PATH)) fs.unlinkSync(UI_EVENTS_PATH);
}

test.beforeEach(() => clearEvents());

test('VALID_UI_ACTIONS contains all expected actions', () => {
    assert.ok(VALID_UI_ACTIONS.has('navigate'));
    assert.ok(VALID_UI_ACTIONS.has('open_drawer'));
    assert.ok(VALID_UI_ACTIONS.has('close_drawer'));
    assert.ok(VALID_UI_ACTIONS.has('set_drawer_section'));
    assert.ok(VALID_UI_ACTIONS.has('set_guard_mode'));
    assert.ok(VALID_UI_ACTIONS.has('refresh'));
    assert.ok(VALID_UI_ACTIONS.has('focus_composer'));
    assert.ok(VALID_UI_ACTIONS.has('insert_composer_text'));
});

test('validateUiAction rejects unknown actions', () => {
    assert.throws(() => validateUiAction('nuke_database'), /Unsupported UI action/);
});

test('createUiEvent persists event to JSONL', () => {
    const e = createUiEvent({ action: 'navigate', target: '/settings/memory-knowledge' });
    assert.equal(e.action, 'navigate');
    assert.equal(e.target, '/settings/memory-knowledge');
    assert.match(e.id, /^evt_/);
    assert.ok(fs.existsSync(UI_EVENTS_PATH));
});

test('listUiEvents returns events in chronological order', () => {
    createUiEvent({ action: 'navigate', target: '/settings/memory-knowledge' });
    createUiEvent({ action: 'open_drawer' });
    createUiEvent({ action: 'set_drawer_section', target: 'tasks' });
    const events = listUiEvents();
    assert.equal(events.length, 3);
    assert.equal(events[0].action, 'navigate');
    assert.equal(events[1].action, 'open_drawer');
    assert.equal(events[2].action, 'set_drawer_section');
});

test('listUiEvents supports since parameter for polling', () => {
    const a = createUiEvent({ action: 'navigate', target: '/x' });
    createUiEvent({ action: 'open_drawer' });
    const after = listUiEvents({ since: a.id });
    assert.equal(after.length, 1);
    assert.equal(after[0].action, 'open_drawer');
});

test('august__ui_control tool routes through executeAugustToolCall', async () => {
    const { executeAugustToolCall } = require('../services/tools/august-tools');
    const r = await executeAugustToolCall('august__ui_control', {
        action: 'navigate',
        target: '/settings/memory-knowledge'
    }, false);
    assert.equal(r.ok, true);
    assert.equal(r.event.action, 'navigate');
    assert.equal(r.event.target, '/settings/memory-knowledge');
});

test('august__ui_control mutating action requires approval', async () => {
    const { executeAugustToolCall } = require('../services/tools/august-tools');
    const r = await executeAugustToolCall('august__ui_control', {
        action: 'set_guard_mode',
        target: 'full'
    }, false);
    assert.equal(r.ok, false);
    assert.equal(r.requiresApproval, true);
});

test('august__ui_control mutating action works with approvedMutation', async () => {
    const { executeAugustToolCall } = require('../services/tools/august-tools');
    const r = await executeAugustToolCall('august__ui_control', {
        action: 'set_guard_mode',
        target: 'full'
    }, true);
    assert.equal(r.ok, true);
    assert.equal(r.event.action, 'set_guard_mode');
});

test('august__ui_control rejects unknown action', async () => {
    const { executeAugustToolCall } = require('../services/tools/august-tools');
    const r = await executeAugustToolCall('august__ui_control', {
        action: 'click_dom',
        target: '#button'
    }, true);
    assert.equal(r.ok, false);
});
