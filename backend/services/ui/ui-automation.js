/**
 * UI automation for August.
 *
 * Lets the LLM (via august__ui_control tool) and backend services emit
 * structured UI events that the frontend listens to via a CustomEvent:
 *
 *   window.dispatchEvent(new CustomEvent('august:ui-action', { detail: { ... } }))
 *
 * Locked decision 3: API/state events only — no DOM clicks/fills.
 *
 * Actions: navigate | open_drawer | close_drawer | set_drawer_section |
 *          set_guard_mode | refresh | focus_composer | insert_composer_text
 *
 * Events are also persisted as JSONL at data/august_ui_events.jsonl for
 * replay/observability.
 */

const fs = require('fs');
const path = require('path');
const { dataPath } = require('../../lib/data-paths');

const VALID_UI_ACTIONS = new Set([
    'navigate',
    'open_drawer',
    'close_drawer',
    'set_drawer_section',
    'set_guard_mode',
    'refresh',
    'focus_composer',
    'insert_composer_text'
]);

const UI_EVENTS_PATH = dataPath('august_ui_events.jsonl');

function validateUiAction(action) {
    if (!VALID_UI_ACTIONS.has(String(action))) {
        throw new Error(`Unsupported UI action: ${action}`);
    }
}

function createUiEvent({ action, target, payload } = {}) {
    validateUiAction(action);
    const event = {
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'august:ui-action',
        action: String(action),
        target: target || null,
        payload: payload || {},
        at: new Date().toISOString()
    };
    try {
        fs.mkdirSync(path.dirname(UI_EVENTS_PATH), { recursive: true });
        fs.appendFileSync(UI_EVENTS_PATH, JSON.stringify(event) + '\n', 'utf8');
    } catch (_) { /* best effort */ }
    return event;
}

function listUiEvents({ since } = {}) {
    if (!fs.existsSync(UI_EVENTS_PATH)) return [];
    const raw = fs.readFileSync(UI_EVENTS_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const events = [];
    for (const line of lines) {
        try {
            const e = JSON.parse(line);
            if (since && e.id && e.id <= since) continue;
            events.push(e);
        } catch (_) { /* skip malformed */ }
    }
    return events;
}

module.exports = {
    VALID_UI_ACTIONS,
    UI_EVENTS_PATH,
    createUiEvent,
    listUiEvents,
    validateUiAction
};
