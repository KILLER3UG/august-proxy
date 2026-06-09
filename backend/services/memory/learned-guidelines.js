const fs = require('fs');
const path = require('path');

const DEFAULT_GUIDELINES_FILE = path.join(__dirname, '..', '..', '..', 'data', 'august_learned_guidelines.json');
const MAX_GUIDELINES = 200;

function getGuidelinesFile() {
    return process.env.AUGUST_LEARNED_GUIDELINES_FILE || DEFAULT_GUIDELINES_FILE;
}

function normalizeGuidelineText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function readLearnedGuidelines() {
    const filePath = getGuidelinesFile();
    if (!fs.existsSync(filePath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function writeLearnedGuidelines(items) {
    const filePath = getGuidelinesFile();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(items.slice(-MAX_GUIDELINES), null, 2));
}

function newGuidelineId() {
    return `guide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function upsertLearnedGuideline(text, { source = 'auto_memory', confidence = 0.6, status = 'pending' } = {}) {
    const normalized = normalizeGuidelineText(text);
    if (!normalized) return null;

    const items = readLearnedGuidelines();
    const existing = items.find(item => normalizeGuidelineText(item.text).toLowerCase() === normalized.toLowerCase());
    const now = new Date().toISOString();

    if (existing) {
        existing.lastSeenAt = now;
        existing.count = Number(existing.count || 1) + 1;
        existing.confidence = Math.max(Number(existing.confidence || 0), Number(confidence || 0));
        if (existing.status === 'rejected' || existing.status === 'archived') {
            // Do not auto-reopen a rejected rule.
        } else if (status === 'active') {
            existing.status = 'active';
        }
        writeLearnedGuidelines(items);
        return existing;
    }

    const item = {
        id: newGuidelineId(),
        text: normalized,
        source,
        confidence,
        status,
        count: 1,
        createdAt: now,
        lastSeenAt: now,
        lastUsedAt: null
    };
    items.push(item);
    writeLearnedGuidelines(items);
    return item;
}

function listLearnedGuidelines({ status } = {}) {
    const items = readLearnedGuidelines();
    if (!status || status === 'all') return items;
    return items.filter(item => item.status === status);
}

function setLearnedGuidelineStatus(idOrText, status) {
    if (!['pending', 'active', 'rejected', 'archived'].includes(status)) {
        throw new Error('status must be one of pending, active, rejected, archived');
    }
    const needle = normalizeGuidelineText(idOrText).toLowerCase();
    const items = readLearnedGuidelines();
    const item = items.find(entry => String(entry.id || '').toLowerCase() === needle ||
        normalizeGuidelineText(entry.text).toLowerCase() === needle);
    if (!item) return null;
    item.status = status;
    item.updatedAt = new Date().toISOString();
    writeLearnedGuidelines(items);
    return item;
}

function getActiveGuidelineTexts(legacyGuidelines = []) {
    const active = listLearnedGuidelines({ status: 'active' }).map(item => item.text);
    const legacy = (Array.isArray(legacyGuidelines) ? legacyGuidelines : [])
        .map(normalizeGuidelineText)
        .filter(Boolean);
    const seen = new Set();
    return [...legacy, ...active].filter(text => {
        const key = text.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function formatGuidelineReview(status = 'pending') {
    const items = listLearnedGuidelines({ status });
    if (!items.length) return `No learned guidelines with status "${status}".`;
    return items.map(item => [
        `- ${item.id} [${item.status}] ${item.text}`,
        `  source=${item.source || 'unknown'} confidence=${item.confidence ?? 'n/a'} count=${item.count || 1}`
    ].join('\n')).join('\n');
}

module.exports = {
    formatGuidelineReview,
    getActiveGuidelineTexts,
    getGuidelinesFile,
    listLearnedGuidelines,
    normalizeGuidelineText,
    readLearnedGuidelines,
    setLearnedGuidelineStatus,
    upsertLearnedGuideline,
    writeLearnedGuidelines
};
