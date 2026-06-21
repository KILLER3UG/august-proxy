/**
 * file-read-cache.js — process-level read cache for the workbench file tools.
 *
 * Replaces the previous `readTimestamps` Map (which only stored mtimes) with
 * a richer record that lets us catch content changes that don't bump mtime
 * (e.g. `touch -t`, in-place edits by an external editor that preserves
 * mtime, or concurrent writes by another agent).
 *
 * Stored record shape:
 *   { mtimeMs, contentHash, sizeBytes, lastReadAt, readBy }
 *
 * `contentHash` is a 16-char prefix of sha256(content). Good enough for
 * change detection; cheaper than full sha256 for big files.
 *
 * The module is intentionally tiny and synchronous on the read side because
 * it is in the hot path of every file mutation guard. The expensive bit is
 * the hash itself, which only happens when `recordRead` is called.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cache = new Map();

function nowIso() {
    return new Date().toISOString();
}

function hashContent(content) {
    return crypto.createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16);
}

/**
 * Resolve `path` to an absolute, normalized form. Symlinks are NOT followed
 * — the cache key must match what the mutating tool sees when it stats the
 * file, otherwise every write would falsely report a stale cache.
 */
function normalizePath(filePath) {
    if (!filePath) return '';
    try {
        return path.resolve(String(filePath));
    } catch (_) {
        return String(filePath);
    }
}

/**
 * Record a read of `filePath` with the given `content`. Safe to call on a
 * path that does not exist — it simply leaves the cache untouched.
 */
function recordRead(filePath, content, { readBy = 'agent' } = {}) {
    const key = normalizePath(filePath);
    if (!key) return null;
    try {
        const stat = fs.statSync(key);
        const entry = {
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
            contentHash: hashContent(content),
            lastReadAt: nowIso(),
            readBy
        };
        cache.set(key, entry);
        return entry;
    } catch (_) {
        // File doesn't exist (e.g. will be created on write). Drop any
        // stale entry and record nothing.
        cache.delete(key);
        return null;
    }
}

/**
 * Drop the cached entry for a path. Called after a successful write/delete/
 * move so the next read sees fresh content.
 */
function invalidate(filePath) {
    cache.delete(normalizePath(filePath));
}

function clear() {
    cache.clear();
}

function size() {
    return cache.size;
}

function get(filePath) {
    return cache.get(normalizePath(filePath)) || null;
}

/**
 * Detect whether the file at `filePath` has changed since the last recorded
 * read. Returns one of:
 *   { stale: false, entry }                      — cache empty (first time)
 *   { stale: false, entry, reason: 'unchanged' } — no change
 *   { stale: true,  entry, reason, currentHash, currentMtime, currentSize }
 *
 * `requireReRead` is purely informational (it doesn't change behaviour);
 * callers use the flag to decide whether to block the mutation.
 */
function detectStale(filePath, { requireReRead = true } = {}) {
    const key = normalizePath(filePath);
    const entry = cache.get(key);

    let current = null;
    try {
        const stat = fs.statSync(key);
        current = {
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size
        };
    } catch (_) {
        // File missing — treat as "stale" if we had a cached entry, otherwise
        // "fresh" (nothing to compare against).
        if (!entry) return { stale: false, entry: null, reason: 'no_cache', fileMissing: true };
        return {
            stale: true,
            entry,
            reason: 'file_missing',
            currentHash: null,
            currentMtime: null,
            currentSize: null,
            requireReRead
        };
    }

    if (!entry) {
        return { stale: false, entry: null, reason: 'no_cache', current };
    }

    if (current.mtimeMs !== entry.mtimeMs) {
        return {
            stale: true,
            entry,
            reason: 'mtime_changed',
            currentHash: null,
            currentMtime: current.mtimeMs,
            currentSize: current.sizeBytes,
            requireReRead
        };
    }

    if (current.sizeBytes !== entry.sizeBytes) {
        return {
            stale: true,
            entry,
            reason: 'size_changed',
            currentHash: null,
            currentMtime: current.mtimeMs,
            currentSize: current.sizeBytes,
            requireReRead
        };
    }

    return { stale: false, entry, reason: 'unchanged', current };
}

/**
 * Read a small preview snippet of the file on disk to surface in the
 * stale-warning message. Capped to avoid blowing up the response.
 */
function readPreviewSnippet(filePath, { maxChars = 200 } = {}) {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const slice = text.slice(0, maxChars);
        return {
            ok: true,
            content: slice,
            truncated: text.length > maxChars,
            totalLength: text.length
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = {
    recordRead,
    invalidate,
    clear,
    detectStale,
    readPreviewSnippet,
    get,
    size,
    _normalizePath: normalizePath
};