// ── Summarizing context compressor ──
// Replaces the oldest middle messages in a conversation with a single fenced
// summary message, while protecting the first `headCount` non-system
// messages and the last `tailCount` non-system messages. Works behind
// session-store.compression_locks so concurrent compactions are safe.
//
// Enable via AUGUST_SUMMARIZING_COMPACTOR=1. Falls back to the legacy
// threshold-based `compactMessagesToThreshold` in backend/adapters/base.js
// when the flag is off or the lock cannot be acquired.

const { estimateTokens } = require('../../lib/tokens');
const sessionStore = require('../storage/session-store');

const DEFAULT_HEAD_COUNT = 4;
const DEFAULT_TAIL_COUNT = 6;
const DEFAULT_SUMMARY_MARKER = '<<compressed_summary';
const DEFAULT_MAX_SUMMARY_CHARS = 2000;
const LOCK_HOLDER = 'summarizing-compactor';
const FEATURE_FLAG = 'AUGUST_SUMMARIZING_COMPACTOR';

function isFeatureEnabled() {
    return process.env[FEATURE_FLAG] === '1';
}

/**
 * Default local summarizer. Joins text content from each middle message,
 * truncates to `maxSummaryChars`, and returns the summary string. When an
 * LLM-based summarizer is wired in, callers pass `options.summarizer`.
 */
function localSummarize(messages, { maxSummaryChars = DEFAULT_MAX_SUMMARY_CHARS } = {}) {
    const lines = [];
    for (const m of messages) {
        const role = m.role || 'unknown';
        let text = '';
        if (typeof m.content === 'string') {
            text = m.content;
        } else if (Array.isArray(m.content)) {
            text = m.content
                .filter(b => b && (b.type === 'text' || b.type === 'output_text'))
                .map(b => b.text || '')
                .join(' ');
        } else if (m.content) {
            try { text = JSON.stringify(m.content); } catch (_) { text = String(m.content); }
        }
        if (m.tool_calls && m.tool_calls.length) {
            const names = m.tool_calls.map(tc => tc.function?.name || tc.name).filter(Boolean);
            if (names.length) text += ` [tool_calls: ${names.join(', ')}]`;
        }
        const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 600);
        if (trimmed) lines.push(`[${role}] ${trimmed}`);
    }
    let summary = lines.join('\n');
    if (summary.length > maxSummaryChars) {
        summary = summary.slice(0, maxSummaryChars) + '…';
    }
    return summary;
}

/**
 * Build the fenced summary message. Metadata includes the compressed
 * message count and the time so downstream consumers can inspect what was
 * collapsed.
 */
function buildSummaryMessage(middleMessages, summaryText, summaryMarker, at = new Date().toISOString()) {
    const meta = JSON.stringify({
        marker: 'august.summary',
        compressedCount: middleMessages.length,
        at,
    });
    return {
        role: 'system',
        content: `${summaryMarker}\n${meta}\n${summaryText}\n${summaryMarker.replace(/^</, '<\\/')}>>`,
    };
}

/**
 * Compress messages to fit within a token threshold by summarizing the middle
 * while preserving the head and tail. Pure function — does not touch the
 * session store. Caller is responsible for locking and persistence.
 *
 * Returns one of:
 *   { changed: true, messages, summary }   — compaction was applied
 *   { changed: false, messages, reason }  — no compaction needed
 */
function summarizeMessagesToThreshold(messages, tools, threshold, {
    headCount = DEFAULT_HEAD_COUNT,
    tailCount = DEFAULT_TAIL_COUNT,
    summaryMarker = DEFAULT_SUMMARY_MARKER,
    summarizer = localSummarize,
    maxSummaryChars = DEFAULT_MAX_SUMMARY_CHARS,
} = {}) {
    if (!Array.isArray(messages)) return { changed: false, messages: [], reason: 'messages-not-array' };
    if (typeof threshold !== 'number' || threshold <= 0) {
        return { changed: false, messages, reason: 'invalid-threshold' };
    }
    if (estimateTokens(messages, tools) <= threshold) {
        return { changed: false, messages, reason: 'under-threshold' };
    }

    const systemMessages = messages.filter(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    if (otherMessages.length <= headCount + tailCount) {
        return { changed: false, messages, reason: 'too-few-to-summarize' };
    }

    const head = otherMessages.slice(0, headCount);
    const tail = otherMessages.slice(otherMessages.length - tailCount);
    const middle = otherMessages.slice(headCount, otherMessages.length - tailCount);

    // Classify system messages by their position relative to non-system
    // messages. Leading system messages stay at the start; trailing ones stay
    // at the end; the (rare) middle ones go to the start to preserve context.
    const firstNonSystemIdx = messages.findIndex(m => m.role !== 'system');
    const lastNonSystemIdx = messages.length - 1 - [...messages].reverse().findIndex(m => m.role !== 'system');
    const leadingSystem = [];
    const trailingSystem = [];
    for (const sm of systemMessages) {
        const originalIdx = messages.indexOf(sm);
        if (originalIdx < firstNonSystemIdx) leadingSystem.push(sm);
        else if (originalIdx > lastNonSystemIdx) trailingSystem.push(sm);
        else leadingSystem.push(sm);
    }

    const summaryText = summarizer(middle, { maxSummaryChars });
    const summaryMessage = buildSummaryMessage(middle, summaryText, summaryMarker);

    const rebuilt = [...leadingSystem, ...head, summaryMessage, ...tail, ...trailingSystem];
    const rebuiltTokens = estimateTokens(rebuilt, tools);

    return {
        changed: true,
        messages: rebuilt,
        summary: {
            headCount,
            tailCount,
            compressedCount: middle.length,
            originalTokens: estimateTokens(messages, tools),
            compressedTokens: rebuiltTokens,
            underThreshold: rebuiltTokens <= threshold,
        },
    };
}

/**
 * Acquire the compression lock, run `summarizeMessagesToThreshold`, and
 * release the lock. Returns the compaction result (or null if the lock is
 * held by another holder).
 *
 * Pure helper that does not write to the session store; callers decide
 * whether to persist the rebuilt messages via `replaceMessages` or
 * `rewindToMessage`.
 */
async function compactWithLock(sessionId, messages, tools, threshold, options = {}) {
    if (!sessionId || !sessionStore.isReady()) return null;
    const acquired = sessionStore.acquireCompressionLock(sessionId, LOCK_HOLDER, 300);
    if (!acquired) return { changed: false, messages, reason: 'lock-held' };
    try {
        return summarizeMessagesToThreshold(messages, tools, threshold, options);
    } finally {
        sessionStore.releaseCompressionLock(sessionId);
    }
}

module.exports = {
    summarizeMessagesToThreshold,
    localSummarize,
    buildSummaryMessage,
    compactWithLock,
    isFeatureEnabled,
    FEATURE_FLAG,
    LOCK_HOLDER,
    DEFAULT_HEAD_COUNT,
    DEFAULT_TAIL_COUNT,
    DEFAULT_SUMMARY_MARKER,
    DEFAULT_MAX_SUMMARY_CHARS,
};
