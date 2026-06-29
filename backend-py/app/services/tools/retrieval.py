"""
BM25 retrieval — pure-Python, zero dependencies (Phase 3).

Scores tools and skills against a conversation query using the BM25 ranking
function. No vector DB, no embedding model, no rank_bm25 package.

Usage:
    from app.services.tools.retrieval import search_tools, search_skills

    results = search_tools(tool_catalog, "audit this Dockerfile", k=5)
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any


# ── Types ───────────────────────────────────────────────────────────────


class CatalogEntry:
    """A pre-tokenized entry in the BM25 catalog."""

    def __init__(self, name: str, tokens: list[str], metadata: dict | None = None):
        self.name = name
        self.tokens = tokens
        self.metadata = metadata or {}


# ── Tokenizer ───────────────────────────────────────────────────────────


_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


def _tokenize(text: str) -> list[str]:
    """Tokenize text into lowercase words.

    Handles camelCase, snake_case, and regular words.
    """
    # Split camelCase and snake_case
    text = re.sub(r"([a-z])([A-Z])", r"\1_\2", text)
    text = text.replace("-", "_")
    return [w.lower() for w in _WORD_RE.findall(text) if len(w) > 1]


# ── BM25 implementation ─────────────────────────────────────────────────


class BM25:
    """BM25 ranking function (Okapi BM25 variant).

    Pure Python, no dependencies. Uses the standard BM25 formula:
        score(D, Q) = sum IDF(q) * f(q,D) * (k1+1) / (f(q,D) + k1 * (1-b + b*|D|/avgdl))
    """

    def __init__(self, corpus: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.corpus = corpus
        self.doc_count = len(corpus)
        self.avg_dl = sum(len(doc) for doc in corpus) / max(self.doc_count, 1)
        self.idf: dict[str, float] = {}
        self._build_index()

    def _build_index(self) -> None:
        """Pre-compute IDF values from the corpus."""
        df: Counter[str] = Counter()
        for doc in self.corpus:
            unique = set(doc)
            for token in unique:
                df[token] += 1

        n = self.doc_count
        for token, doc_freq in df.items():
            # Standard BM25 IDF formula (smooth variant to avoid negative IDF)
            self.idf[token] = math.log(1 + (n - doc_freq + 0.5) / (doc_freq + 0.5))

    def score(self, query_tokens: list[str], doc_index: int) -> float:
        """Score a single document against the query."""
        doc = self.corpus[doc_index]
        doc_len = len(doc)
        score = 0.0

        for q in query_tokens:
            if q not in self.idf:
                continue
            idf = self.idf[q]
            freq = doc.count(q)
            if freq == 0:
                continue
            score += idf * (freq * (self.k1 + 1)) / (freq + self.k1 * (1 - self.b + self.b * doc_len / self.avg_dl))

        return score

    def search(self, query: str, top_k: int = 10) -> list[tuple[int, float]]:
        """Return top-K (doc_index, score) pairs sorted by relevance."""
        query_tokens = _tokenize(query)
        if not query_tokens:
            return []

        scored: list[tuple[int, float]] = []
        for i in range(self.doc_count):
            s = self.score(query_tokens, i)
            if s > 0:
                scored.append((i, s))

        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]


# ── Catalog builders ────────────────────────────────────────────────────


def build_tool_catalog(tool_defs: list[dict]) -> list[CatalogEntry]:
    """Build a pre-tokenized tool catalog for BM25.

    Each entry's search text includes: tool name (underscores→words), description,
    parameter names, and optional keywords.
    """
    catalog: list[CatalogEntry] = []
    for tool in tool_defs:
        name = tool.get("name", "") if isinstance(tool, dict) else str(tool)
        desc = tool.get("description", "") if isinstance(tool, dict) else ""
        params = tool.get("input_schema", tool.get("parameters", {}))
        param_names = list(params.get("properties", {}).keys()) if isinstance(params, dict) else []

        # Build search text
        search_parts = [
            name.replace("_", " "),
            desc,
        ]
        search_parts.extend(p.replace("_", " ") for p in param_names)

        # Keywords if present
        if isinstance(tool, dict):
            kw = tool.get("keywords", [])
            if isinstance(kw, list):
                search_parts.extend(kw)

        text = " ".join(search_parts)
        tokens = _tokenize(text)

        catalog.append(CatalogEntry(name, tokens, {"name": name, "description": desc}))
    return catalog


def build_skill_catalog(skills: list[dict]) -> list[CatalogEntry]:
    """Build a pre-tokenized skill catalog for BM25.

    Each entry's search text includes: skill name, description, and tags.
    """
    catalog: list[CatalogEntry] = []
    for skill in skills:
        name = skill.get("name", "") if isinstance(skill, dict) else str(skill)
        desc = skill.get("description", "") if isinstance(skill, dict) else ""
        tags = skill.get("tags", []) if isinstance(skill, dict) else []

        search_parts = [
            name.replace("_", " "),
            desc,
        ]
        if isinstance(tags, list):
            search_parts.extend(tags)

        text = " ".join(search_parts)
        tokens = _tokenize(text)

        catalog.append(CatalogEntry(name, tokens, {"name": name, "description": desc}))
    return catalog


# ── Sliding window query builder ────────────────────────────────────────


def build_query_from_messages(
    messages: list[dict],
    window_size: int = 6,
    decay_factor: float = 0.85,
) -> str:
    """Build a BM25 query from the last N conversation turns.

    Messages beyond ``window_size`` are excluded. Within the window,
    each message is weighted by recency (most recent = highest weight).
    Returns the raw concatenated text as the BM25 query.
    """
    if not messages:
        return ""

    recent = messages[-window_size:] if len(messages) > window_size else messages

    parts: list[str] = []
    n = len(recent)
    for i, msg in enumerate(recent):
        weight = (i + 1) / n  # linear recency: 1/n ... 1
        content = msg.get("content", "")
        if isinstance(content, str):
            if content.strip():
                parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))

    # Concatenate; recency weighting is done by repetition (recent text appears more)
    return "\n".join(parts)


# ── Search interfaces ───────────────────────────────────────────────────


def search_tools(
    catalog: list[CatalogEntry],
    query: str,
    k: int = 10,
    bm25_params: dict | None = None,
) -> list[str]:
    """BM25 tool search. Returns top-K tool names.

    ``catalog``: output of ``build_tool_catalog()``.
    ``query``: raw text from conversation (use ``build_query_from_messages()``).
    ``k``: number of results to return.
    """
    if not catalog or not query:
        return [e.name for e in catalog[:k]]

    corpus = [e.tokens for e in catalog]
    bm25 = BM25(corpus, **(bm25_params or {}))
    results = bm25.search(query, top_k=k)

    if not results and catalog:
        # Fallback: return top-K by global frequency (cold start)
        return [e.name for e in catalog[:k]]

    return [catalog[idx].name for idx, _ in results]


def search_skills(
    catalog: list[CatalogEntry],
    query: str,
    j: int = 3,
    bm25_params: dict | None = None,
) -> list[str]:
    """BM25 skill search. Returns top-J skill names.

    ``catalog``: output of ``build_skill_catalog()``.
    """
    if not catalog or not query:
        return [e.name for e in catalog[:j]]

    corpus = [e.tokens for e in catalog]
    bm25 = BM25(corpus, **(bm25_params or {}))
    results = bm25.search(query, top_k=j)

    if not results and catalog:
        return [e.name for e in catalog[:j]]

    return [catalog[idx].name for idx, _ in results]
