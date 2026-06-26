"""
Fuzzy matching — string similarity and approximate search.

Port of backend/services/memory/fuzzy-match.js.
"""

from __future__ import annotations

import re
from typing import Any


def levenshtein(a: str, b: str) -> int:
    """Compute Levenshtein distance between two strings."""
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(curr[j] + 1, prev[j + 1] + 1, prev[j] + (ca != cb)))
        prev = curr
    return prev[-1]


def similarity(a: str, b: str) -> float:
    """Compute similarity ratio (0.0 to 1.0) between two strings."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    dist = levenshtein(a, b)
    max_len = max(len(a), len(b))
    return 1.0 - (dist / max_len)


def fuzzy_search(query: str, candidates: list[str], threshold: float = 0.6) -> list[tuple[str, float]]:
    """Find candidates that match the query above a similarity threshold."""
    results = []
    for c in candidates:
        score = similarity(query.lower(), c.lower())
        if score >= threshold:
            results.append((c, score))
    results.sort(key=lambda x: x[1], reverse=True)
    return results


def token_sort_ratio(a: str, b: str) -> float:
    """Compare strings by sorting their tokens first."""
    tokens_a = sorted(re.findall(r"\w+", a.lower()))
    tokens_b = sorted(re.findall(r"\w+", b.lower()))
    return similarity(" ".join(tokens_a), " ".join(tokens_b))
