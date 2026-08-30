"""Shared BM25 text-similarity ratio (Part 16 Phase B).

Extracted from the scale-free ratio idiom in
``memory_store.fact_retrieval.find_similar_facts`` so callers outside the
facts index (episode fingerprint paraphrase dedupe) share one
implementation. Lexical BM25 only — no embeddings, per the Part 16
non-goals. ``ratio = BM25(A→B) / BM25(B→B)`` ∈ [0, 1]; callers compare
against the consolidation merge threshold (0.85) for near-duplicates.
"""

from __future__ import annotations

from app.services.tools.retrieval import BM25, _tokenize


def similarity(textA: str, textB: str) -> float:
    """Scale-free BM25 similarity between two texts ∈ [0, 1].

    1.0 = A is (lexically) contained in B completely. Empty or
    token-free inputs return 0.0 — no lexical signal, no guess.
    """
    aTokens = _tokenize((textA or '').strip())
    bTokens = _tokenize((textB or '').strip())
    if not aTokens or not bTokens:
        return 0.0
    bm25 = BM25([aTokens, bTokens])
    cross = bm25.score(aTokens, 1)
    selfScore = bm25.score(bTokens, 1)
    if selfScore <= 0 or cross <= 0:
        return 0.0
    return min(1.0, cross / selfScore)
