"""
Memory quality — scores and filters memory entries by quality metrics.

Port of backend/services/memory/memory-quality.js.
"""

from __future__ import annotations
import re
from app.jsonUtils import as_str, as_float


def scoreQuality(text: str) -> dict[str, object]:
    """Score the quality of a memory text entry."""
    if not text:
        return {'score': 0, 'reasons': ['empty']}
    score = 1.0
    reasons = []
    if len(text) < 10:
        score -= 0.3
        reasons.append('too_short')
    elif len(text) > 100:
        score += 0.1
        reasons.append('substantial')
    if re.search('[A-Z]', text):
        score += 0.1
    if re.search('\\d+', text):
        score += 0.1
    if ':' in text or '- ' in text:
        score += 0.1
    actionWords = ['implemented', 'created', 'fixed', 'changed', 'added', 'removed', 'updated']
    if any((w in text.lower() for w in actionWords)):
        score += 0.2
        reasons.append('actionable')
    uniqueChars = len(set(text.lower()))
    if uniqueChars < 5 and len(text) > 20:
        score -= 0.5
        reasons.append('low_entropy')
    if re.search('(.{10,})\\1', text):
        score -= 0.3
        reasons.append('repetitive')
    return {'score': round(max(0, min(score, 2.0)), 2), 'reasons': reasons}


def filterHighQuality(entries: list[dict[str, object]], minScore: float = 0.5) -> list[dict[str, object]]:
    """Filter memory entries by quality score."""
    scored = []
    for e in entries:
        text = as_str(e.get('content')) or as_str(e.get('text')) or str(e.get('value', ''))
        q = scoreQuality(text)
        if as_float(q.get('score')) >= minScore:
            scored.append({**e, '_quality': q})
    return scored


def deduplicate(entries: list[dict[str, object]], threshold: float = 0.85) -> list[dict[str, object]]:
    """Remove near-duplicate entries."""
    if not entries:
        return []
    from app.services.memory.fuzzy_match import similarity

    kept = [entries[0]]
    for e in entries[1:]:
        textE = str(e.get('content', '') or e.get('text', ''))
        if all((similarity(textE, str(k.get('content', '') or k.get('text', ''))) < threshold for k in kept)):
            kept.append(e)
    return kept
