/**
 * chat-event-log.js — session-scoped event log for chat generations.
 *
 * Owns the per-session append-only event stream that drives:
 *   - the live SSE channel to every open frontend subscriber
 *   - the catch-up replay when a subscriber reconnects (with `sinceSeq`)
 *   - the on-disk JSONL log so events survive a backend restart
 *
 * The chat thread's `MessageBlock` reducer on the frontend consumes these
 * events; the backend workbench loop emits them via the `emit(type, payload)`
 * callback. This module just records, fans out, and persists — it does NOT
 * shape the events themselves.
 *
 * Storage:
 *   - In-memory: bounded ring per session (last MAX_IN_MEMORY events).
 *   - On disk: `data/chat_events_<sessionId>.log` JSONL, capped at
 *     MAX_FILE_BYTES via a rolling rename to `<…>.log.1`. Pruning the on-disk
 *     log is a best-effort background task; the SSE contract is
 *     "deliver everything with seq > sinceSeq" while the backend is running,
 *     and "deliver everything on disk on startup" for the first reconnect
 *     after a backend restart.
 */

const fs = require('fs');
const path = require('path');
const { dataPath } = require('../../lib/data-paths');

const MAX_IN_MEMORY = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FILE_ROTATE_KEEP = 1;
const ROLLING_FLUSH_INTERVAL_MS = 250;

/**
 * @typedef {Object} ChatLogEntry
 * @property {number} seq           Monotonic per-session seq starting at 1.
 * @property {string} type          Event kind (e.g. 'thinking', 'text', 'subagent_start').
 * @property {object} payload       Event payload, opaque to this module.
 * @property {number} at            Epoch ms when the entry was appended.
 */

/** @type {Map<string, {
 *   events: ChatLogEntry[],
 *   seq: number,
 *   listeners: Set<{write: (entry: ChatLogEntry) => boolean, onError?: (err: Error) => void}>,
 *   pendingWrites: string[],
 *   flushTimer: NodeJS.Timeout | null,
 *   closing: boolean
 * }>} */
const sessions = new Map();

function fileFor(sessionId) {
    if (!sessionId) return null;
    // Keep filenames safe: only allow [A-Za-z0-9_-]. Workbench session ids
    // already match this shape but we sanitise defensively.
    const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
    return dataPath(`chat_events_${safe}.log`);
}

function getOrCreate(sessionId) {
    let entry = sessions.get(sessionId);
    if (entry) return entry;
    entry = {
        events: [],
        seq: 0,
        listeners: new Set(),
        pendingWrites: [],
        flushTimer: null,
        closing: false,
    };
    sessions.set(sessionId, entry);
    primeFromDisk(sessionId, entry);
    return entry;
}

function primeFromDisk(sessionId, entry) {
    const filePath = fileFor(sessionId);
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_BYTES) {
            // Roll: keep at most FILE_ROTATE_KEEP prior files. We rename
            // `<…>.log` → `<…>.log.1` and start fresh. Older .log.N files
            // beyond the keep window are removed.
            const rotated = `${filePath}.1`;
            try { if (fs.existsSync(rotated)) fs.unlinkSync(rotated); } catch (_) {}
            fs.renameSync(filePath, rotated);
        }
    } catch (_) {
        // If we can't stat or rotate, attempt to read what we can below.
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
            if (!line) continue;
            try {
                const parsed = JSON.parse(line);
                if (typeof parsed.seq === 'number') {
                    entry.events.push(parsed);
                    if (parsed.seq > entry.seq) entry.seq = parsed.seq;
                }
            } catch (_) {
                // Skip malformed lines silently — this is a best-effort replay.
            }
        }
        // Bound in-memory ring to MAX_IN_MEMORY after priming.
        if (entry.events.length > MAX_IN_MEMORY) {
            entry.events.splice(0, entry.events.length - MAX_IN_MEMORY);
        }
    } catch (_) {
        // If the file is unreadable, start empty; new writes will recreate it.
    }
}

function scheduleFlush(entry) {
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        flushSync(entry);
    }, ROLLING_FLUSH_INTERVAL_MS);
}

function flushSync(entry) {
    if (!entry.pendingWrites.length) return;
    // Grab the first session id matching this entry; in practice there's one
    // entry per sessionId but we still recover it safely.
    let sessionId = null;
    for (const [key, value] of sessions.entries()) {
        if (value === entry) { sessionId = key; break; }
    }
    if (!sessionId) { entry.pendingWrites = []; return; }
    const filePath = fileFor(sessionId);
    if (!filePath) { entry.pendingWrites = []; return; }

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, entry.pendingWrites.join(''));
        entry.pendingWrites = [];
    } catch (e) {
        // Drop the pending writes to avoid unbounded growth; the in-memory
        // ring still has them so live subscribers keep working.
        console.warn('[chat-event-log] disk flush failed:', e.message);
        entry.pendingWrites = [];
    }
}

function fanOut(entry, logEntry) {
    for (const listener of Array.from(entry.listeners)) {
        try {
            const keepOpen = listener.write(logEntry);
            if (keepOpen === false) entry.listeners.delete(listener);
        } catch (err) {
            // A misbehaving writer shouldn't kill the others. Drop it so we
            // don't keep throwing on every subsequent event.
            entry.listeners.delete(listener);
            try { listener.onError?.(err); } catch (_) { /* noop */ }
        }
    }
}

/**
 * Append an event to the per-session log. Returns the assigned ChatLogEntry
 * (with its monotonic `seq`) so callers can use it for cursor tracking.
 *
 * @param {string|null|undefined} sessionId
 * @param {string} type
 * @param {object} [payload]
 * @returns {ChatLogEntry|null}
 */
function append(sessionId, type, payload = {}) {
    if (!sessionId) return null;
    const entry = getOrCreate(sessionId);
    entry.seq += 1;
    const logEntry = {
        seq: entry.seq,
        type: String(type || 'event'),
        payload: payload && typeof payload === 'object' ? payload : {},
        at: Date.now(),
    };
    entry.events.push(logEntry);
    if (entry.events.length > MAX_IN_MEMORY) {
        entry.events.splice(0, entry.events.length - MAX_IN_MEMORY);
    }
    entry.pendingWrites.push(JSON.stringify(logEntry) + '\n');
    scheduleFlush(entry);
    fanOut(entry, logEntry);
    return logEntry;
}

/**
 * Subscribe to live events for a session. The writer is invoked synchronously
 * for every new event; `onError` is called if the writer throws.
 *
 * If `sinceSeq` is provided, every event in the current ring with
 * `seq > sinceSeq` is replayed before the writer is attached. Returns the
 * count of replayed events so the caller can log/observe the replay.
 *
 * @param {string} sessionId
 * @param {{write: (entry: ChatLogEntry) => any, onError?: (err: Error) => void}} writer
 * @param {{sinceSeq?: number}} [options]
 * @returns {{unsubscribe: () => void, replayed: number, currentSeq: number}}
 */
function subscribe(sessionId, writer, { sinceSeq } = {}) {
    if (!sessionId || !writer || typeof writer.write !== 'function') {
        return { unsubscribe: () => {}, replayed: 0, currentSeq: 0 };
    }
    const entry = getOrCreate(sessionId);
    let replayed = 0;
    if (Number.isFinite(sinceSeq)) {
        for (const ev of entry.events) {
            if (ev.seq > sinceSeq) {
                try {
                    const keepOpen = writer.write(ev);
                    replayed += 1;
                    if (keepOpen === false) break;
                } catch (err) {
                    try { writer.onError?.(err); } catch (_) {}
                    return { unsubscribe: () => entry.listeners.delete(writer), replayed, currentSeq: entry.seq };
                }
            }
        }
    }
    entry.listeners.add(writer);
    return {
        unsubscribe: () => entry.listeners.delete(writer),
        replayed,
        currentSeq: entry.seq,
    };
}

/**
 * Return a snapshot of the latest N events for the session. Used by REST
 * endpoints that want to seed a UI without holding an open SSE.
 *
 * @param {string} sessionId
 * @param {number} [limit=200]
 * @returns {ChatLogEntry[]}
 */
function getRecent(sessionId, limit = 200) {
    if (!sessionId) return [];
    const entry = sessions.get(sessionId);
    if (!entry) {
        // No active session in memory; attempt a one-off disk read so a
        // freshly-reconnected UI can still see history across restarts.
        if (!fs.existsSync(fileFor(sessionId))) return [];
        try {
            const raw = fs.readFileSync(fileFor(sessionId), 'utf8');
            const lines = raw.split(/\r?\n/).filter(Boolean);
            const events = [];
            for (const line of lines) {
                try { events.push(JSON.parse(line)); } catch (_) {}
            }
            return events.slice(-Math.max(1, limit));
        } catch (_) { return []; }
    }
    const cap = Math.max(1, Math.min(2000, Number(limit) || 200));
    return entry.events.slice(-cap);
}

/**
 * Drop the in-memory state for a session. Does NOT touch the on-disk log.
 * Useful for tests or administrative cleanup; not part of the normal flow.
 *
 * @param {string} sessionId
 */
function resetSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    try { flushSync(entry); } catch (_) {}
    sessions.delete(sessionId);
}

function hasSession(sessionId) {
    return sessions.has(sessionId);
}

function currentSeq(sessionId) {
    const entry = sessions.get(sessionId);
    return entry ? entry.seq : 0;
}

module.exports = {
    append,
    subscribe,
    getRecent,
    resetSession,
    hasSession,
    currentSeq,
    MAX_IN_MEMORY,
    MAX_FILE_BYTES,
};
