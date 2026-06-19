/**
 * Post-observation helper for mutating computer_* tools (Lift L3, Review #3).
 *
 * After any mutating computer_* tool succeeds, capture a fresh screenshot
 * to disk and write a linkage audit entry. Storage path:
 *
 *   data/computer-observations/<id>.png   (the PNG, base64-decoded)
 *
 * Audit linkage (no base64 in JSONL):
 *   {
 *     action: 'computer.post_observation',
 *     target: <focusedApp>,
 *     postObservation: { screenshotPath, capturedAt, focusedApp }
 *   }
 *
 * Toggled by config: security.postObservationScreenshot (default true).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath } = require('../../lib/data-paths');

const OBSERVATIONS_DIR = dataPath('computer-observations');

const POST_OBSERVATION_TOOLS = new Set([
    'computer_mouse_click',
    'computer_mouse_double_click',
    'computer_mouse_right_click',
    'computer_type',
    'computer_key',
    'computer_focus_window',
    'computer_launch',
    'computer_open_browser',
    'computer_close_browser',
    'computer_clipboard_set'
]);

function ensureDir() {
    fs.mkdirSync(OBSERVATIONS_DIR, { recursive: true });
}

function isPostObservationTool(name) {
    return POST_OBSERVATION_TOOLS.has(String(name));
}

function isPostObservationEnabled() {
    try {
        const { getConfig } = require('../../lib/config');
        const sec = getConfig().security || {};
        return sec.postObservationScreenshot !== false;
    } catch (_) {
        return true; // default ON
    }
}

async function resolveFocusedApp(hostAgent) {
    try {
        const winRes = await hostAgent.execute('computer_list_windows', {});
        const wins = (winRes && Array.isArray(winRes.windows)) ? winRes.windows : (Array.isArray(winRes) ? winRes : []);
        const fg = wins.find(w => w && w.isForeground === true);
        return fg ? (fg.processName || fg.title || null) : null;
    } catch (_) {
        return null;
    }
}

/**
 * Capture post-observation: screenshot + audit entry.
 * Returns the postObservation object or null when disabled / failed.
 */
async function capturePostObservation(toolName, args, focusedApp, hostAgent) {
    if (!isPostObservationEnabled()) return null;
    if (!isPostObservationTool(toolName)) return null;

    let screenshotPath = null;
    try {
        ensureDir();
        const ss = await hostAgent.execute('computer_screenshot', {});
        if (ss && ss.base64) {
            const id = crypto.randomUUID();
            const file = path.join(OBSERVATIONS_DIR, `${id}.png`);
            fs.writeFileSync(file, Buffer.from(ss.base64, 'base64'));
            screenshotPath = file;
        }
    } catch (_) {
        // screenshot failed — record null path, keep going
    }

    const observedFocus = (await resolveFocusedApp(hostAgent)) || focusedApp || null;
    const capturedAt = new Date().toISOString();
    const postObservation = {
        screenshotPath,
        capturedAt,
        focusedApp: observedFocus
    };

    try {
        const { appendAuditEntry } = require('../audit/audit-log');
        appendAuditEntry({
            action: 'computer.post_observation',
            target: toolName,
            category: 'computer',
            inputSummary: { tool: toolName, observedFocus },
            postObservation,
            result: 'ok'
        });
    } catch (_) { /* best effort */ }

    return postObservation;
}

module.exports = {
    OBSERVATIONS_DIR,
    POST_OBSERVATION_TOOLS,
    isPostObservationTool,
    isPostObservationEnabled,
    capturePostObservation,
    resolveFocusedApp
};
