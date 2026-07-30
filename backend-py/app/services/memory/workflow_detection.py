"""Repeated workflow detection — identifies patterns across sessions.

Part of Better Harness Plan Phase 3.3.
Runs during consolidation cycle. Clusters sessions by topic + first-message
similarity. ≥3 similar sessions with shared tool sequence → workflow candidate.
"""

from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)

_MIN_SESSIONS_FOR_CANDIDATE = 3
_SIMILARITY_THRESHOLD = 0.70


def detect_workflow_candidates() -> list[dict]:
    """Analyze recent sessions for repeated workflow patterns.

    Returns list of workflow candidates:
    [{id, name, sessionIds, commonTopic, confidence, detectedAt}]
    """
    try:
        from app.services.memory_store import _conn

        conn = _conn()

        # Get sessions with topics from last 30 days
        sessions = conn.execute('''
            SELECT s.id, s.title, st.topic, st.confidence
            FROM sessions s
            LEFT JOIN session_topics st ON st.session_id = s.id
            WHERE s.started_at > datetime('now', '-30 days')
            AND s.message_count > 2
            ORDER BY s.started_at DESC
            LIMIT 100
        ''').fetchall()

        if len(sessions) < _MIN_SESSIONS_FOR_CANDIDATE:
            return []

        # Cluster by topic
        topic_clusters: dict[str, list[dict]] = {}
        for row in sessions:
            topic = row['topic'] or 'general'
            if topic not in topic_clusters:
                topic_clusters[topic] = []
            topic_clusters[topic].append({
                'id': row['id'],
                'title': row['title'] or '',
                'topicConfidence': row['confidence'] or 0.5,
            })

        # Find clusters with ≥3 sessions
        candidates = []
        for topic, cluster in topic_clusters.items():
            if len(cluster) < _MIN_SESSIONS_FOR_CANDIDATE:
                continue

            # Check title similarity within cluster (simple word overlap)
            titles = [s['title'] for s in cluster if s['title']]
            if len(titles) >= _MIN_SESSIONS_FOR_CANDIDATE and _titles_are_similar(titles):
                confidence = min(0.5 + len(cluster) * 0.1, 0.95)
                candidate_id = f'wf_{topic.replace(" ", "_")[:30]}'
                candidates.append({
                    'id': candidate_id,
                    'name': _humanize_topic(topic),
                    'sessionIds': [s['id'] for s in cluster[:10]],
                    'commonTopic': topic,
                    'sessionCount': len(cluster),
                    'confidence': round(confidence, 2),
                })

        # Store candidates in KV for frontend access
        if candidates:
            from app.services.memory_store import save_memory
            save_memory('workflow_candidates', json.dumps(candidates))
            logger.info('Detected %d workflow candidates', len(candidates))

        return candidates
    except Exception as exc:
        logger.debug('Workflow detection failed: %s', exc)
        return []


def _titles_are_similar(titles: list[str], threshold: float = 0.4) -> bool:
    """Check if titles share common words (simple similarity heuristic).

    Uses word overlap ratio. Requires >threshold of words to be shared
    across the majority of titles.
    """
    if len(titles) < 2:
        return False

    # Extract significant words (skip short/common words)
    stop_words = {'the', 'a', 'an', 'is', 'are', 'was', 'in', 'on', 'to', 'for', 'of', 'and', 'or', 'with', 'how', 'what', 'fix', 'add'}
    word_sets = []
    for title in titles:
        words = {w.lower() for w in title.split() if len(w) > 2 and w.lower() not in stop_words}
        if words:
            word_sets.append(words)

    if len(word_sets) < 2:
        return False

    # Check pairwise overlap for majority of pairs
    similar_pairs = 0
    total_pairs = 0
    for i in range(len(word_sets)):
        for j in range(i + 1, len(word_sets)):
            total_pairs += 1
            overlap = len(word_sets[i] & word_sets[j])
            union = len(word_sets[i] | word_sets[j])
            if union > 0 and overlap / union >= threshold:
                similar_pairs += 1

    return total_pairs > 0 and similar_pairs / total_pairs >= 0.5


def _humanize_topic(topic: str) -> str:
    """Convert a topic slug to a human-readable name."""
    return topic.replace('_', ' ').replace('-', ' ').title()


def get_workflow_candidates() -> list[dict]:
    """Retrieve stored workflow candidates."""
    try:
        from app.services.memory_store import get_memory
        raw = get_memory('workflow_candidates')
        if raw and isinstance(raw, str):
            return json.loads(raw)
    except Exception:
        pass
    return []
