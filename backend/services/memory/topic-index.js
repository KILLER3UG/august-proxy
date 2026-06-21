/**
 * topic-index.js — topic classification + grouping for sessions.
 *
 * Topics are auto-classified from the task text using the same vocabulary
 * the brain orchestrator already uses (`debug`, `code_edit`, `research`,
 * `memory_question`, `planning`, `system_control`, `chat`). They are
 * persisted to the `session_topics` table added by the topic migration.
 *
 * The classification is heuristic — it deliberately stays in JS rather than
 * calling an LLM so it costs nothing per session.
 */

const { classifyTask } = require('./brain-orchestrator');

const { runPrepared, allSql } = (() => {
    try {
        return require('./sqlite-memory-store');
    } catch (_) {
        return { runPrepared: () => false, allSql: () => [] };
    }
})();

const VALID_TOPICS = new Set([
    'debug', 'code_edit', 'research', 'memory_question',
    'planning', 'system_control', 'chat'
]);

function nowIso() {
    return new Date().toISOString();
}

/**
 * Normalize arbitrary text into a topic slug. Falls back to 'chat' when no
 * category matches.
 */
function classifyTopic(text) {
    const t = String(text || '').trim();
    if (!t) return 'chat';
    const category = classifyTask(t);
    if (VALID_TOPICS.has(category)) return category;
    return 'chat';
}

/**
 * Record the topic for a session. Idempotent — calling twice with the same
 * session id overwrites the previous row. Returns the persisted record.
 */
function indexSession({ sessionId, taskText, parentTopic = null, confidence = 0.75 } = {}) {
    if (!sessionId) return null;
    const topic = classifyTopic(taskText);
    const now = nowIso();
    runPrepared(
        `INSERT INTO session_topics (session_id, topic, parent_topic, confidence, classified_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
            topic=excluded.topic,
            parent_topic=excluded.parent_topic,
            confidence=excluded.confidence,
            classified_at=excluded.classified_at`,
        [sessionId, topic, parentTopic, Number(confidence) || 0.75, now]
    );
    return { sessionId, topic, parentTopic, confidence: Number(confidence) || 0.75, classifiedAt: now };
}

function getSessionTopic(sessionId) {
    if (!sessionId) return null;
    const rows = allSql(
        `SELECT session_id, topic, parent_topic, confidence, classified_at
         FROM session_topics WHERE session_id = ?`,
        [sessionId]
    );
    if (!rows || !rows.length) return null;
    const r = rows[0];
    return {
        sessionId: r.session_id,
        topic: r.topic,
        parentTopic: r.parent_topic || null,
        confidence: r.confidence,
        classifiedAt: r.classified_at
    };
}

/**
 * Return sessions grouped by topic. Joined with the `sessions` table
 * (from session-store.js) so we get `updated_at`, `title`, etc.
 *
 * Note: we deliberately don't import session-store here to avoid a circular
 * dependency. Callers that want joined session rows should pass the
 * `sessions` array in via `sessionsLookup`.
 */
function getSessionsByTopic(opts = {}) {
    const { topic, parentTopic, limit = 50, order = 'newest', sessionsLookup = null } = opts;
    const where = [];
    const params = [];
    if (topic) { where.push('topic = ?'); params.push(topic); }
    if (parentTopic) { where.push('parent_topic = ?'); params.push(parentTopic); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const dir = order === 'oldest' ? 'ASC' : 'DESC';
    const rows = allSql(
        `SELECT session_id, topic, parent_topic, confidence, classified_at
         FROM session_topics
         ${whereClause}
         ORDER BY classified_at ${dir}
         LIMIT ?`,
        [...params, Math.max(1, Math.min(500, Number(limit) || 50))]
    );
    if (!rows) return [];
    const lookup = typeof sessionsLookup === 'function'
        ? sessionsLookup
        : (sessionsLookup && typeof sessionsLookup === 'object' ? (id) => sessionsLookup[id] || null : null);
    return rows.map(r => ({
        sessionId: r.session_id,
        topic: r.topic,
        parentTopic: r.parent_topic || null,
        confidence: r.confidence,
        classifiedAt: r.classified_at,
        session: lookup ? lookup(r.session_id) : null
    }));
}

/**
 * Add a row to memory_relationships. Idempotent by (source, target, relationship).
 */
function addRelationship(source, target, relationship, weight = 1.0) {
    if (!source || !target || !relationship) return false;
    const id = `rel_${[source.type, source.id, target.type, target.id, relationship].join('|')}`.slice(0, 200);
    const now = nowIso();
    runPrepared(
        `INSERT INTO memory_relationships
            (id, source_type, source_id, target_type, target_id, relationship, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET weight=excluded.weight`,
        [
            id,
            String(source.type),
            String(source.id),
            String(target.type),
            String(target.id),
            String(relationship),
            Number(weight) || 1.0,
            now
        ]
    );
    return true;
}

/**
 * BFS over memory_relationships from a starting node. Returns `{ nodes, edges }`
 * suitable for rendering a small graph in the UI.
 */
function scanRelated({ sourceType, sourceId, depth = 1 } = {}) {
    if (!sourceType || !sourceId) return { nodes: [], edges: [] };
    const seen = new Set();
    const edges = [];
    const nodes = [];
    const startId = `${sourceType}:${sourceId}`;
    seen.add(startId);
    nodes.push({ id: startId, type: sourceType, label: sourceId });

    let frontier = [{ type: sourceType, id: sourceId }];
    for (let d = 0; d < depth; d++) {
        if (!frontier.length) break;
        const placeholders = frontier.map(() => '(?, ?)').join(', ');
        const params = [];
        for (const f of frontier) { params.push(f.type, f.id); }
        const rows = allSql(
            `SELECT source_type, source_id, target_type, target_id, relationship, weight
             FROM memory_relationships
             WHERE (source_type, source_id) IN (${placeholders})
                OR (target_type, target_id) IN (${placeholders})`,
            [...params, ...params]
        );
        const next = [];
        for (const r of rows || []) {
            edges.push({
                from: `${r.source_type}:${r.source_id}`,
                to: `${r.target_type}:${r.target_id}`,
                relationship: r.relationship,
                weight: r.weight
            });
            const candidates = [
                { type: r.source_type, id: r.source_id },
                { type: r.target_type, id: r.target_id }
            ];
            for (const c of candidates) {
                const cid = `${c.type}:${c.id}`;
                if (!seen.has(cid)) {
                    seen.add(cid);
                    nodes.push({ id: cid, type: c.type, label: c.id });
                    next.push(c);
                }
            }
        }
        frontier = next;
    }

    return { nodes, edges };
}

function countRelationships() {
    const rows = allSql('SELECT COUNT(*) AS count FROM memory_relationships', []);
    return rows && rows[0] ? Number(rows[0].count) || 0 : 0;
}

module.exports = {
    VALID_TOPICS,
    classifyTopic,
    indexSession,
    getSessionTopic,
    getSessionsByTopic,
    addRelationship,
    scanRelated,
    countRelationships
};