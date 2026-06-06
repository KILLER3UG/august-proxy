const fs = require('fs');
const path = require('path');
const sqliteMemory = require('./sqlite-memory-store');

const VECTOR_DB_FILE = path.join(__dirname, '..', '..', 'data', 'august_infinite_memory.json');
const LOCAL_VECTOR_DIMS = 256;
const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function isValidEmbedding(embedding) {
    return Array.isArray(embedding)
        && embedding.length > 0
        && embedding.every(value => Number.isFinite(Number(value)));
}

function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .match(/[a-z0-9_:-]+/g) || [];
}

function stableEntryId(topic, summary, timestamp) {
    return `mem_${hashString(`${topic}\n${summary}\n${timestamp || ''}`).toString(16)}`;
}

function normalizeTags(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(tag => String(tag || '').trim())
        .filter(Boolean);
}

function normalizeMetadata(entry = {}, meta = {}) {
    const raw = {
        ...(entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}),
        ...(meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : {})
    };

    for (const key of ['type', 'session_id', 'user_id', 'project', 'task', 'outcome', 'source']) {
        const value = meta[key] !== undefined ? meta[key] : entry[key];
        if (value !== undefined && value !== null && value !== '') raw[key] = value;
    }

    const tags = normalizeTags(meta.tags !== undefined ? meta.tags : (entry.tags || raw.tags));
    if (tags.length > 0) raw.tags = tags;
    return raw;
}

function entrySearchText(entry = {}) {
    const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
    const tags = normalizeTags(entry.tags || metadata.tags).join(' ');
    return [
        entry.topic,
        entry.summary,
        metadata.type,
        metadata.project,
        metadata.task,
        metadata.outcome,
        metadata.source,
        tags
    ].filter(Boolean).join('\n');
}

function createLocalEmbedding(text, dims = LOCAL_VECTOR_DIMS) {
    const vector = Array.from({ length: dims }, () => 0);
    const tokens = tokenize(text);
    if (tokens.length === 0) return vector;

    for (const token of tokens) {
        const hash = hashString(token);
        const index = hash % dims;
        const sign = (hash & 1) === 0 ? 1 : -1;
        vector[index] += sign;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
    if (!norm) return vector;
    return vector.map(value => Number((value / norm).toFixed(6)));
}

function normalizeEntry(entry = {}) {
    const topic = String(entry.topic || 'Untitled checkpoint').trim();
    const summary = String(entry.summary || '').trim();
    const sourceText = `Topic: ${topic}\nSummary: ${summary}`;
    const validEmbedding = isValidEmbedding(entry.embedding);
    const timestamp = entry.timestamp || new Date().toISOString();
    const metadata = normalizeMetadata(entry);
    return {
        id: entry.id || metadata.id || stableEntryId(topic, summary, timestamp),
        topic,
        summary,
        embedding: validEmbedding ? entry.embedding.map(Number) : createLocalEmbedding(sourceText),
        timestamp,
        embeddingSource: entry.embeddingSource || (validEmbedding ? 'provider' : 'local-fallback'),
        metadata,
        tags: normalizeTags(entry.tags || metadata.tags)
    };
}

/**
 * Ensures the DB file exists and returns its contents.
 */
function readDB() {
    if (!fs.existsSync(VECTOR_DB_FILE)) {
        fs.writeFileSync(VECTOR_DB_FILE, JSON.stringify([]));
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(VECTOR_DB_FILE, 'utf8'));
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeEntry);
    } catch (e) {
        return [];
    }
}

/**
 * Saves the DB contents.
 */
function writeDB(data) {
    fs.writeFileSync(VECTOR_DB_FILE, JSON.stringify(data, null, 2));
}

/**
 * Compute the cosine similarity between two vectors (arrays of numbers).
 * Returns a score between -1 and 1.
 */
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function matchesFilters(entry, filters = {}) {
    const entries = Object.entries(filters || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
    if (entries.length === 0) return true;
    const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
    for (const [key, expected] of entries) {
        const actual = key === 'tags'
            ? normalizeTags(entry.tags || metadata.tags)
            : (entry[key] !== undefined ? entry[key] : metadata[key]);
        if (Array.isArray(expected)) {
            if (expected.length === 0) continue;
            if (Array.isArray(actual)) {
                const actualSet = new Set(actual.map(item => String(item).toLowerCase()));
                if (!expected.some(item => actualSet.has(String(item).toLowerCase()))) return false;
            } else if (!expected.map(item => String(item).toLowerCase()).includes(String(actual || '').toLowerCase())) {
                return false;
            }
            continue;
        }
        if (Array.isArray(actual)) {
            if (!actual.map(item => String(item).toLowerCase()).includes(String(expected).toLowerCase())) return false;
            continue;
        }
        if (String(actual || '').toLowerCase() !== String(expected).toLowerCase()) return false;
    }
    return true;
}

function bm25Scores(query, entries) {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || entries.length === 0) return new Map();

    const docs = entries.map(entry => {
        const tokens = tokenize(entrySearchText(entry));
        const frequencies = new Map();
        for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
        return { entry, tokens, frequencies };
    });
    const avgLength = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / Math.max(1, docs.length);
    const df = new Map();
    for (const term of queryTerms) {
        df.set(term, docs.filter(doc => doc.frequencies.has(term)).length);
    }

    const result = new Map();
    for (const doc of docs) {
        let score = 0;
        const docLength = Math.max(1, doc.tokens.length);
        for (const term of queryTerms) {
            const frequency = doc.frequencies.get(term) || 0;
            if (frequency === 0) continue;
            const documentFrequency = df.get(term) || 0;
            const idf = Math.log(1 + ((docs.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
            const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / Math.max(1, avgLength)));
            score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
        }
        result.set(doc.entry.id, score);
    }
    return result;
}

function rankedBy(items, scoreKey) {
    return items
        .filter(item => Number(item[scoreKey]) > 0)
        .sort((a, b) => Number(b[scoreKey]) - Number(a[scoreKey]))
        .map((item, index) => [item.id, index + 1]);
}

function rankLookup(rankPairs) {
    return new Map(rankPairs);
}

function compactResult(item) {
    return {
        id: item.id,
        topic: item.topic,
        summary: item.summary,
        timestamp: item.timestamp,
        embeddingSource: item.embeddingSource,
        metadata: item.metadata,
        tags: item.tags,
        score: item.score,
        lexicalScore: item.lexicalScore,
        vectorScore: item.vectorScore,
        bm25Score: item.bm25Score,
        retrieval: item.retrieval
    };
}

function hybridSearchEntries(query, entries, topK = 5, options = {}) {
    const normalized = (entries || []).map(normalizeEntry).filter(entry => matchesFilters(entry, options.filters));
    if (!String(query || '').trim() || normalized.length === 0) return [];

    const queryEmbedding = options.queryEmbedding && isValidEmbedding(options.queryEmbedding)
        ? options.queryEmbedding.map(Number)
        : createLocalEmbedding(query);
    const bm25 = bm25Scores(query, normalized);
    const ftsRanks = options.ftsRanks instanceof Map ? options.ftsRanks : new Map();
    const scored = normalized.map(entry => ({
        ...entry,
        vectorScore: cosineSimilarity(queryEmbedding, entry.embedding),
        bm25Score: bm25.get(entry.id) || 0,
        sqliteFtsRank: ftsRanks.get(entry.id) || null
    }));
    const vectorRank = rankLookup(rankedBy(scored, 'vectorScore'));
    const bm25Rank = rankLookup(rankedBy(scored, 'bm25Score'));

    const fused = scored.map(entry => {
        const vRank = vectorRank.get(entry.id);
        const bRank = bm25Rank.get(entry.id);
        const fRank = entry.sqliteFtsRank;
        const rrfScore = (vRank ? 1 / (RRF_K + vRank) : 0)
            + (bRank ? 1 / (RRF_K + bRank) : 0)
            + (fRank ? 1 / (RRF_K + fRank) : 0);
        return {
            ...entry,
            lexicalScore: entry.bm25Score,
            _rrfScore: rrfScore,
            retrieval: {
                method: 'hybrid-rrf',
                vectorRank: vRank || null,
                bm25Rank: bRank || null,
                sqliteFtsRank: fRank || null,
                rrfScore,
                filters: options.filters || {}
            }
        };
    })
        .filter(entry => entry._rrfScore > 0 || entry.vectorScore > 0 || entry.bm25Score > 0)
        .sort((a, b) => b._rrfScore - a._rrfScore || b.bm25Score - a.bm25Score || b.vectorScore - a.vectorScore);

    const maxScore = fused.reduce((max, entry) => Math.max(max, entry._rrfScore), 0);
    return fused.slice(0, topK).map(entry => compactResult({
        ...entry,
        score: maxScore > 0 ? Number((entry._rrfScore / maxScore).toFixed(6)) : Math.max(entry.vectorScore, entry.bm25Score)
    }));
}

/**
 * Save a new checkpoint with its embedding to the local vector DB.
 */
function saveCheckpointWithEmbedding(topic, summary, embedding, meta = {}) {
    const db = readDB();
    const normalizedTopic = String(topic || 'Untitled checkpoint').trim();
    const normalizedSummary = String(summary || '').trim();
    const sourceText = `Topic: ${normalizedTopic}\nSummary: ${normalizedSummary}`;
    const validEmbedding = isValidEmbedding(embedding);
    const timestamp = meta.timestamp || new Date().toISOString();
    const metadata = normalizeMetadata({ topic: normalizedTopic, summary: normalizedSummary, timestamp }, meta);
    const nextEntry = {
        id: meta.id || metadata.id || stableEntryId(normalizedTopic, normalizedSummary, timestamp),
        topic: normalizedTopic,
        summary: normalizedSummary,
        embedding: validEmbedding ? embedding.map(Number) : createLocalEmbedding(sourceText),
        timestamp,
        embeddingSource: meta.embeddingSource || (validEmbedding ? 'provider' : 'local-fallback'),
        metadata,
        tags: normalizeTags(meta.tags || metadata.tags)
    };

    const existingIndex = db.findIndex(entry =>
        String(entry.topic || '').toLowerCase() === normalizedTopic.toLowerCase()
        && String(entry.summary || '').toLowerCase() === normalizedSummary.toLowerCase()
    );

    if (existingIndex >= 0) {
        db[existingIndex] = { ...db[existingIndex], ...nextEntry };
    } else {
        db.push(nextEntry);
    }
    writeDB(db);
    try {
        sqliteMemory.upsertMemory(nextEntry);
    } catch (e) {
        // SQLite is an acceleration layer; JSON remains the local-first fallback.
    }
    return nextEntry;
}

/**
 * Search the local vector DB using a query embedding.
 * Returns the top K results.
 */
function searchCheckpoints(queryEmbedding, topK = 3, options = {}) {
    const db = readDB().filter(entry => matchesFilters(entry, options.filters));
    
    // Calculate similarity scores for all entries
    const scored = db.map(entry => {
        return {
            topic: entry.topic,
            summary: entry.summary,
            timestamp: entry.timestamp,
            embeddingSource: entry.embeddingSource,
            metadata: entry.metadata,
            tags: entry.tags,
            score: cosineSimilarity(queryEmbedding, entry.embedding)
        };
    });
    
    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);
    
    // Return top K
    return scored.slice(0, topK);
}

function readVectorEntries() {
    return readDB();
}

function lexicalScore(query, entry) {
    const terms = tokenize(query);
    if (terms.length === 0) return 0;
    const haystack = entrySearchText(entry).toLowerCase();
    const matches = terms.filter(term => haystack.includes(term)).length;
    return matches / terms.length;
}

function searchCheckpointsByText(query, topK = 5, options = {}) {
    const db = readDB();
    let ftsRanks = new Map();
    try {
        const status = sqliteMemory.getMemoryStoreStatus();
        if (status.available && Number(status.count || 0) > 0) {
            const fts = sqliteMemory.searchMemoryFts(query, { limit: Math.max(topK * 4, 20) });
            ftsRanks = new Map(fts.map(item => [item.id, item.ftsRank]));
        }
    } catch (e) {
        ftsRanks = new Map();
    }
    return hybridSearchEntries(query, db, topK, { ...options, ftsRanks });
}

function searchTextEntries(query, topK = 8, options = {}) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    return searchCheckpointsByText(query, topK, options)
        .map(entry => ({
            ...entry,
            matches: terms.filter(term => entrySearchText(entry).toLowerCase().includes(term)).length
        }));
}

function backfillVectorEntriesFromCoreMemory(memory) {
    const checkpoints = Array.isArray(memory?.conversation_checkpoints)
        ? memory.conversation_checkpoints
        : [];
    let indexed = 0;
    for (const checkpoint of checkpoints) {
        if (!checkpoint?.summary) continue;
        saveCheckpointWithEmbedding(
            checkpoint.topic || 'Conversation checkpoint',
            checkpoint.summary,
            null,
            {
                timestamp: checkpoint.timestamp,
                embeddingSource: 'local-backfill'
            }
        );
        indexed++;
    }
    return {
        indexed,
        count: readDB().length
    };
}

function deleteCheckpoint(id) {
    if (!id) return false;
    const db = readDB();
    const before = db.length;
    const next = db.filter(entry => entry.id !== id);
    if (next.length === before) return false;
    writeDB(next);
    try {
        sqliteMemory.deleteMemory(id);
    } catch (e) {
        // Best-effort mirror cleanup.
    }
    return true;
}

function syncSqliteMemoryStore() {
    return sqliteMemory.syncVectorEntries(readDB());
}

module.exports = {
    backfillVectorEntriesFromCoreMemory,
    createLocalEmbedding,
    deleteCheckpoint,
    hybridSearchEntries,
    isValidEmbedding,
    readVectorEntries,
    saveCheckpointWithEmbedding,
    searchCheckpoints,
    searchCheckpointsByText,
    searchTextEntries,
    syncSqliteMemoryStore
};
