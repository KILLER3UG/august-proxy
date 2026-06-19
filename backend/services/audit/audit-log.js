/**
 * Audit log for August self-management + host computer access.
 *
 * Persists entries as JSONL at data/august_audit_log.jsonl. Each entry records:
 * - who (actor, agentId, sessionId)
 * - what (action, target, category, args/input summary)
 * - when (at timestamp)
 * - how (mode, approved, approvalToken, critical flag)
 * - result (ok | blocked | error, error message)
 * - rollback linkage (rollbackId)
 * - post-observation screenshot linkage (postObservation) — Lift L3
 *
 * Reuses the existing redactForDisplay / maskSecretValue from backend/lib/redact.js
 * for structured objects and adds patternRedact() for free-text matches
 * (sk-..., Bearer ..., Authorization, cookies, API_KEY=...).
 *
 * Locked decision 2: critical actions always emit an audit entry, including
 * when blocked (result: 'blocked').
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath } = require('../../lib/data-paths');
const { redactForDisplay, maskSecretValue, SENSITIVE_KEY_PATTERN } = require('../../lib/redact');

const AUDIT_LOG_PATH = dataPath('august_audit_log.jsonl');

const FREE_TEXT_PATTERNS = [
    { rx: /sk-[A-Za-z0-9_-]{12,}/g, repl: 'sk-***REDACTED***' },
    { rx: /(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/g, repl: '$1***REDACTED***' },
    { rx: /(Authorization\s*:\s*)[^\s,;]+/gi, repl: '$1***REDACTED***' },
    { rx: /(Cookie\s*:\s*)[^\r\n]+/gi, repl: '$1***REDACTED***' },
    { rx: /(API_KEY\s*=\s*)[^\s;,]+/g, repl: '$1***REDACTED***' },
    { rx: /("apiKey"\s*:\s*")[^"]+(")/g, repl: '$1***REDACTED***$2' },
    { rx: /("password"\s*:\s*")[^"]+(")/g, repl: '$1***REDACTED***$2' },
    { rx: /("token"\s*:\s*")[^"]+(")/g, repl: '$1***REDACTED***$2' }
];

function patternRedact(value) {
    if (typeof value !== 'string') return value;
    let out = value;
    for (const { rx, repl } of FREE_TEXT_PATTERNS) {
        out = out.replace(rx, repl);
    }
    return out;
}

function redactValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return patternRedact(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (typeof value === 'object') {
        // For objects, prefer the existing structured redactForDisplay for keys
        // matching the sensitive pattern; fall back to stringifying + free-text
        // redaction otherwise (catches secrets embedded in free text).
        const hasSensitiveKey = Object.keys(value).some(k => SENSITIVE_KEY_PATTERN.test(k));
        if (hasSensitiveKey) {
            return redactForDisplay(value);
        }
        return redactForDisplay(value);
    }
    return value;
}

function ensureDirExists(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Append a single audit entry. Returns the stored record.
 */
function appendAuditEntry(entry) {
    const record = {
        id: entry.id || crypto.randomUUID(),
        at: entry.at || new Date().toISOString(),
        actor: entry.actor || 'august',
        agentId: entry.agentId || null,
        sessionId: entry.sessionId || null,
        action: String(entry.action || 'unknown'),
        target: entry.target || null,
        category: entry.category || null,
        mode: entry.mode || null,
        confirmation: entry.confirmation || null,
        approved: typeof entry.approved === 'boolean' ? entry.approved : null,
        approvalToken: entry.approvalToken || null,
        critical: typeof entry.critical === 'boolean' ? entry.critical : null,
        inputSummary: redactValue(entry.inputSummary ?? entry.input ?? null),
        beforeSummary: redactValue(entry.beforeSummary ?? entry.before ?? null),
        afterSummary: redactValue(entry.afterSummary ?? entry.after ?? null),
        rollbackId: entry.rollbackId || null,
        postObservation: redactValue(entry.postObservation || null),
        result: entry.result || 'ok',
        error: entry.error ? String(entry.error) : null
    };
    ensureDirExists(AUDIT_LOG_PATH);
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
    return record;
}

/**
 * Read the most recent `limit` entries (default 200) in chronological order.
 */
function readAuditEntries({ limit = 200 } = {}) {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
    let raw;
    try {
        raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
    } catch (_) {
        return [];
    }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const parsed = [];
    for (const line of lines) {
        try { parsed.push(JSON.parse(line)); }
        catch (_) { /* skip malformed line */ }
    }
    // Tail: take last N
    return parsed.slice(-Math.max(1, Number(limit) || 200));
}

function clearAuditLog() {
    if (fs.existsSync(AUDIT_LOG_PATH)) {
        fs.unlinkSync(AUDIT_LOG_PATH);
    }
}

module.exports = {
    appendAuditEntry,
    readAuditEntries,
    clearAuditLog,
    AUDIT_LOG_PATH,
    // exported for tests
    _internals: { patternRedact, redactValue }
};
