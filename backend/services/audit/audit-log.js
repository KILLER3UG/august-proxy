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
        const keys = Object.keys(value);
        if (keys.some(k => SENSITIVE_KEY_PATTERN.test(k))) {
            return redactForDisplay(value);
        }
        return patternRedact(JSON.stringify(value));
    }
    return value;
}

function ensureDirExists(filePath) {
    retryOnEperm(() => fs.mkdirSync(path.dirname(filePath), { recursive: true }));
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
    withFileLock(() => {
        ensureDirExists(AUDIT_LOG_PATH);
        retryOnTransient(() => fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n', 'utf8'));
    });
    return record;
}

/**
 * Read audit entries with optional filters.
 *
 * Filters (all optional):
 *   limit, category, actor, action, since, until, summary
 *
 * When `summary: true`, returns aggregate counts instead of entries:
 *   { count, byCategory, byResult, byActor, byCritical, at }
 *
 * Reads the whole JSONL into memory (cheap for ≤ few thousand entries).
 */
function readAuditEntries({ limit = 200, category, actor, action, since, until, summary } = {}) {
    if (!fs.existsSync(AUDIT_LOG_PATH)) {
        return summary ? { count: 0, byCategory: {}, byResult: {}, byActor: {}, byCritical: { true: 0, false: 0, null: 0 }, at: new Date().toISOString() } : [];
    }
    let raw;
    try {
        raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
    } catch (_) {
        return summary ? { count: 0, byCategory: {}, byResult: {}, byActor: {}, byCritical: { true: 0, false: 0, null: 0 }, at: new Date().toISOString() } : [];
    }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const parsed = [];
    for (const line of lines) {
        try { parsed.push(JSON.parse(line)); }
        catch (_) { /* skip malformed line */ }
    }

    if (summary) {
        const byCategory = {};
        const byResult = {};
        const byActor = {};
        const byCritical = { true: 0, false: 0, null: 0 };
        for (const e of parsed) {
            inc(byCategory, e.category || '(uncategorized)');
            inc(byResult, e.result || '(unknown)');
            inc(byActor, e.actor || '(unknown)');
            inc(byCritical, e.critical === true ? 'true' : e.critical === false ? 'false' : 'null');
        }
        return {
            count: parsed.length,
            byCategory,
            byResult,
            byActor,
            byCritical,
            at: new Date().toISOString()
        };
    }

    let entries = parsed;
    if (category) entries = entries.filter(e => e.category === category);
    if (actor)    entries = entries.filter(e => e.actor === actor);
    if (action)   entries = entries.filter(e => e.action === action);
    if (since)    entries = entries.filter(e => String(e.at) >= String(since));
    if (until)    entries = entries.filter(e => String(e.at) <= String(until));

    return entries.slice(-Math.max(1, Number(limit) || 200));
}

function inc(map, key) {
    map[key] = (map[key] || 0) + 1;
}

/**
 * Retry a synchronous fs operation up to 5 times with exponential backoff
 * when Windows throws a transient file-system error from concurrent
 * test-writer contention. EBUSY covers "file is being read by another
 * process" (common on Windows from anti-virus or indexer); EACCES covers
 * "permission denied" from AV/EDR scanners. Other errors propagate
 * immediately.
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function retryOnTransient(fn, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return fn();
        } catch (e) {
            if (TRANSIENT_FS_CODES.has(e.code) && attempt < maxRetries) {
                const delay = Math.min(10 * Math.pow(2, attempt - 1), 200);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
                continue;
            }
            throw e;
        }
    }
}

// Back-compat alias. Older test files and any module that re-exports the
// old name keep working.
const retryOnEperm = retryOnTransient;

/**
 * Cross-process file lock used to serialize concurrent workers (e.g.
 * `node --test` parallel workers) that touch the same on-disk file.
 *
 * Strategy: try to atomically create `${path}.lock`. `fs.openSync(p, 'wx')`
 * succeeds exactly once across all processes; everyone else gets EEXIST
 * and retries with exponential backoff. The lock file is removed in a
 * finally block so a crashed worker leaves no orphan (modulo process
 * death between open and unlink — acceptable since stale locks are
 * removed by the next successful acquirer in its backoff sweep).
 */
const AUDIT_LOCK_PATH = `${AUDIT_LOG_PATH}.lock`;

function withFileLock(fn) {
    for (let i = 0; i < 100; i++) {
        let fd;
        try {
            // Wrap the open itself in retryOnTransient to absorb the
            // Windows-specific case where the open fails with EPERM/EBUSY/
            // EACCES (rather than EEXIST) because another worker still has
            // the lock file open with shared access. EEXIST is the normal
            // "lock held" case and falls through to the outer wait loop.
            fd = retryOnTransient(() => fs.openSync(AUDIT_LOCK_PATH, 'wx'));
        } catch (e) {
            if (e.code === 'EEXIST') {
                const delay = Math.min(5 * Math.pow(1.5, i), 50);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
                continue;
            }
            throw e;
        }
        try {
            return fn();
        } finally {
            try { fs.closeSync(fd); } catch (_) { /* ignore */ }
            try { fs.unlinkSync(AUDIT_LOCK_PATH); } catch (_) { /* ignore */ }
        }
    }
    throw new Error(`File lock timeout: ${AUDIT_LOCK_PATH}`);
}

function clearAuditLog() {
    withFileLock(() => {
        retryOnTransient(() => {
            if (fs.existsSync(AUDIT_LOG_PATH)) {
                fs.unlinkSync(AUDIT_LOG_PATH);
            }
        });
    });
}

module.exports = {
    appendAuditEntry,
    readAuditEntries,
    clearAuditLog,
    AUDIT_LOG_PATH,
    // exported for tests
    _internals: { patternRedact, redactValue }
};
