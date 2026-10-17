"""The memory write bar: what is not worth remembering.

Two reference harnesses converge on the same discipline, and August had none of
it at the door.

* Claude Code's auto-memory keeps exactly four types and refuses "anything it can
  derive from the codebase — architecture, file paths, debugging fixes", plus
  anything the project's own instruction file already says. Its per-line test is
  "would removing this cause a mistake?".
* Hermes' review prompt says it outright: ``SKIP: trivial/obvious info, easily
  re-discovered facts, raw data dumps, task progress, completed-work logs,
  temporary TODO state``, and "if nothing is worth saving, say 'Nothing to
  save.'" — a no-write answer is the expected outcome, not a failure.

August's distiller writes a fact the moment a judge says ``action: memory``,
gated by nothing but "not empty" and the sensitive-topic denylist, and the
result is what the owner reports: a store of one-line noise. Skills got a
substance bar (``skill_service.bodySubstance``); this is the same idea for
memory.

Deliberately **hard-deny only**, never a quality score. Every check below
identifies text that cannot be a durable memory regardless of how well it is
written; anything subtler ("is this useful?") is asked of the judge in the
prompt, where a model can answer it, rather than asserted by a regex here. The
reason is asymmetric cost: a false reject loses one lesson, a false accept
pollutes every future session's recall.
"""

from __future__ import annotations

import re

from app.services.best_effort import best_effort

# ── the one dedupe ladder ──────────────────────────────────────────────────
# Three doors decide "we already know this", and they used three unrelated
# definitions: exact normalized text at the `remember` write door, 0.85 in
# consolidation's merge, and 0.55 here. A fact could therefore be "already
# known" to one door and new to another — which is how a store fills with
# near-copies while every door reports doing its job.
#
# The VALUES are unchanged on purpose: each was tuned per door and nothing has
# measured any of them yet. What changes is that they now live in one place, so
# the first tuning pass that happens after real data exists sees all three at
# once instead of editing one and leaving the other two to drift.
#
# Ratios are BM25(A→B) / BM25(B→B), from fact_retrieval.find_similar_facts.
DUPLICATE_SIMILARITY = 0.55  # the write door: refuse as already-known
MERGE_SIMILARITY = 0.85      # consolidation: fold the older row into the newer
EXACT_SIMILARITY = 1.0       # normalized-text identity (the `remember` door)

# The name the distiller and the turn-outcome promotion import. It is the same
# number as DUPLICATE_SIMILARITY, kept so existing call sites do not change;
# new code should prefer the ladder's named doors.
DEDUPE_SIMILARITY = DUPLICATE_SIMILARITY

# Below this a "lesson" is a label, not a statement anyone can act on.
MIN_STATEMENT_CHARS = 24

# A memory is a rule that stands without the incident that revealed it. Hermes
# states this exactly: "No PR/issue numbers, dates, ticket IDs, or quoted user
# text — the rule must stand without the incident."
_INCIDENT_RE = re.compile(
    r'\b20\d\d-\d\d-\d\d\b|#\d{3,}|\b[A-Z]{2,5}-\d{2,}\b|\bcommit\s+[0-9a-f]{7,40}\b',
    re.IGNORECASE,
)
# Typographic quotes mean the draft is repeating what somebody said rather than
# what follows from it. ASCII apostrophes are too common in ordinary prose
# ("the flow's exit code") to count.
_QUOTED_SPEECH_RE = re.compile('[“”«»]')

# Task-state and completed-work logs. These are the two categories both
# references name first, and they are the ones an unattended pass reaches for
# most eagerly, because they are the most salient thing in the window it just
# read.
_EPHEMERAL_RE = re.compile(
    r'\b(this session|current session|right now|at the moment|today|yesterday'
    r'|for now|yet|still working|in progress|todo|as of (?:now|today)'
    r'|i (?:just|have|will|am)|we (?:just|have|will|are)|the user asked|my last)\b',
    re.IGNORECASE,
)
# A question is a thing to find out, not a thing to remember.
_QUESTION_RE = re.compile(r'[?？]\s*$')
# Runtime state that goes stale silently and then misinforms: versions, ports,
# PIDs, paths under a temp dir, token counts.
_RUNTIME_RE = re.compile(
    r'\b(?:port|pid|token count|context length)s?[:=] ?\d'
    r'|\b(?:/tmp/|/var/folders/|appdata|temp\w*[\\/])'
    r'|\bv?\d+\.\d+\.\d+\b',
    re.IGNORECASE,
)
# Derivable-from-the-project. Not a claim about the repo's contents — the door
# cannot read the workspace — but the shape of the sentences that restate what
# the environment already says, which is the one anti-pattern both references
# name by hand.
_DERIVABLE_RE = re.compile(
    r'\b(?:package\.json|requirements\.txt|pyproject\.toml|cargo\.toml|makefile'
    r'|readme|\.env|dockerfile)\b'
    r'|\b(?:the repo|the codebase)\b.*\b(?:contains|defines|lists|has a)\b',
    re.IGNORECASE,
)


def statementOf(value: object) -> str:
    """The candidate text, collapsed to single spaces (how it is compared)."""
    return ' '.join(str(value or '').split()).strip()


def memoryIsJunk(text: object) -> str:
    """``''`` when this could be a durable memory; the reason when it cannot.

    Each branch is a category one of the two reference harnesses explicitly
    refuses to store, so a rejection here is never a matter of taste.
    """
    statement = statementOf(text)
    if not statement:
        return 'empty'
    if _QUESTION_RE.search(statement):
        return 'a question is not a memory'
    if len(statement) < MIN_STATEMENT_CHARS:
        return f'statement is under {MIN_STATEMENT_CHARS} chars — a label, not a rule'
    if _INCIDENT_RE.search(statement):
        return 'names the incident (date, ticket or commit) rather than the rule'
    if _QUOTED_SPEECH_RE.search(statement):
        return 'quotes what was said instead of what follows from it'
    if _EPHEMERAL_RE.search(statement):
        return 'task state or a completed-work log, which is stale on write'
    if _RUNTIME_RE.search(statement):
        return 'runtime detail that goes stale silently'
    if _DERIVABLE_RE.search(statement):
        return 'restates what the project already documents'
    return ''


def duplicateOf(text: object, *, scope: str = 'global') -> tuple[float, str]:
    """``(ratio, key)`` of the closest existing fact, or ``(0.0, '')``.

    The dedupe lives here rather than at each caller because the two automatic
    doors (the distiller and the turn-outcome promotion) must not be able to
    disagree about what "we already know this" means.
    """
    statement = statementOf(text)
    if not statement:
        return (0.0, '')
    from app.services.memory_store.fact_retrieval import find_similar_facts

    # A dedupe that cannot run must not eat the lesson — the bar is about
    # content, and losing a real memory to an index failure is the wrong trade.
    similar: list[tuple[float, str, str]] = []
    with best_effort('memory-quality.dedupe-lookup'):
        similar = find_similar_facts(statement, k=1, scope=scope)
    if not similar:
        return (0.0, '')
    # `find_similar_facts` yields (ratio, key, title); the key is what a reader
    # looks up, so that is what the caller gets back.
    ratio = float(similar[0][0])
    return (ratio, str(similar[0][1] or ''))
