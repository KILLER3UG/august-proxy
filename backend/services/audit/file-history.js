const fs = require('fs');
const path = require('path');
const { dataPath } = require('../../lib/data-paths');

const AUDIT_LOG_PATH = dataPath('august_audit_log.jsonl');

const FILE_ACTIONS = new Set([
    'write', 'replace', 'delete', 'move',
    'fs_write', 'fs_delete', 'fs_move', 'fs_copy',
    'patch', 'patch_v4a'
]);

function normalizeTarget(input) {
    if (!input) return '';
    try {
        return path.resolve(String(input));
    } catch (_) {
        return String(input);
    }
}

function getFileHistory(filePath, opts = {}) {
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 20));
    const includeFailures = opts.includeFailures !== false;
    const target = normalizeTarget(filePath);
    const targetLower = target.toLowerCase();
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
    const out = [];
    try {
        const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            let entry;
            try { entry = JSON.parse(lines[i]); } catch (_) { continue; }
            const action = String(entry.action || '');
            if (!FILE_ACTIONS.has(action)) continue;
            const entryTarget = normalizeTarget(entry.target || '');
            if (entryTarget.toLowerCase() !== targetLower) continue;
            if (!includeFailures && entry.result && entry.result !== 'ok') continue;
            out.push({
                at: entry.at || null,
                action,
                actor: entry.actor || 'august',
                agentId: entry.agentId || null,
                sessionId: entry.sessionId || null,
                summary: entry.args || entry.input || entry.summary || null,
                result: entry.result || null,
                rollbackId: entry.rollbackId || null
            });
        }
    } catch (e) { return out; }
    return out;
}

function countFileHistory(filePath) {
    const target = normalizeTarget(filePath).toLowerCase();
    if (!target || !fs.existsSync(AUDIT_LOG_PATH)) return 0;
    let count = 0;
    try {
        const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
            let entry;
            try { entry = JSON.parse(line); } catch (_) { continue; }
            if (!FILE_ACTIONS.has(String(entry.action || ''))) continue;
            if (normalizeTarget(entry.target || '').toLowerCase() !== target) continue;
            count++;
        }
    } catch (_) { /* ignore */ }
    return count;
}

module.exports = {
    getFileHistory,
    countFileHistory,
    AUDIT_LOG_PATH
};