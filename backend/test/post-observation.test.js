const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    POST_OBSERVATION_TOOLS,
    isPostObservationTool,
    isPostObservationEnabled,
    OBSERVATIONS_DIR
} = require('../services/computer/post-observation');

const { saveComputerRoots } = require('../services/permissions/permission-profiles');
const { clearAuditLog } = require('../services/audit/audit-log');

test('POST_OBSERVATION_TOOLS contains mutating computer_* tools', () => {
    assert.ok(POST_OBSERVATION_TOOLS.has('computer_mouse_click'));
    assert.ok(POST_OBSERVATION_TOOLS.has('computer_type'));
    assert.ok(POST_OBSERVATION_TOOLS.has('computer_key'));
    assert.ok(POST_OBSERVATION_TOOLS.has('computer_launch'));
    assert.ok(POST_OBSERVATION_TOOLS.has('computer_clipboard_set'));
});

test('POST_OBSERVATION_TOOLS excludes read-only tools', () => {
    assert.ok(!POST_OBSERVATION_TOOLS.has('computer_screenshot'));
    assert.ok(!POST_OBSERVATION_TOOLS.has('computer_list_windows'));
    assert.ok(!POST_OBSERVATION_TOOLS.has('computer_clipboard_get'));
});

test('isPostObservationTool returns true for mutating tools', () => {
    assert.equal(isPostObservationTool('computer_type'), true);
    assert.equal(isPostObservationTool('computer_screenshot'), false);
});

test('isPostObservationEnabled defaults to true', () => {
    assert.equal(isPostObservationEnabled(), true);
});

test('isPostObservationEnabled respects config toggle', () => {
    saveComputerRoots({ postObservationScreenshot: false });
    try {
        assert.equal(isPostObservationEnabled(), false);
    } finally {
        saveComputerRoots({ postObservationScreenshot: true });
    }
});

test('capturePostObservation writes PNG to disk and emits audit entry', async () => {
    // Defensive: ensure the toggle is on at the start of this test, regardless
    // of what other workers have written to data/config.json. The toggling
    // tests above clean up after themselves via try/finally, but a parallel
    // worker running `restore_setting` undo against the same config file can
    // land its write between this worker's getConfig() calls and leave the
    // resolved config in an unexpected state.
    saveComputerRoots({ postObservationScreenshot: true });
    clearAuditLog();
    const { capturePostObservation } = require('../services/computer/post-observation');
    const fakeBase64Png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82
    ]).toString('base64');
    const fakeHostAgent = {
        execute: async (name) => {
            if (name === 'computer_screenshot') return { base64: fakeBase64Png };
            if (name === 'computer_list_windows') return { windows: [{ processName: 'notepad.exe', isForeground: true }] };
            return null;
        }
    };
    const po = await capturePostObservation('computer_type', { text: 'hi' }, 'notepad.exe', fakeHostAgent);
    assert.ok(po, 'postObservation should not be null');
    assert.equal(po.focusedApp, 'notepad.exe');
    assert.ok(po.screenshotPath, 'screenshotPath should be set');
    assert.ok(fs.existsSync(po.screenshotPath), 'PNG should exist on disk');
    // Confirm it's a real PNG (first 8 bytes)
    const buf = fs.readFileSync(po.screenshotPath);
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('capturePostObservation returns null when disabled', async () => {
    saveComputerRoots({ postObservationScreenshot: false });
    try {
        const { capturePostObservation } = require('../services/computer/post-observation');
        const r = await capturePostObservation('computer_type', {}, null, { execute: async () => null });
        assert.equal(r, null);
    } finally {
        saveComputerRoots({ postObservationScreenshot: true });
    }
});

test('capturePostObservation returns null for non-mutating tools', async () => {
    const { capturePostObservation } = require('../services/computer/post-observation');
    const r = await capturePostObservation('computer_screenshot', {}, null, { execute: async () => null });
    assert.equal(r, null);
});
