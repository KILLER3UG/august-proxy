"""Part 16 Phases A+B — episode extraction + tier-1 scoring (2026-08-30).

The self-improvement loop's deterministic half. Units are EPISODES, not
conversations: failure→recovery, correction→accepted, and abandoned-approach
windows mined from what is ALREADY stored — the ``messages`` transcripts,
``turn_outcomes`` telemetry, and ``tool_guardrail_log``. No runtime change
to the chat loop; the whole pass is asynchronous and post-hoc.

Phase B layers tier-1 on top: a fingerprint per episode (turn_outcomes'
signature discipline generalized to ``cause-class:token`` shape), a fixed
six-criterion rubric scored with no model calls, and a cost gate — only the
top slice (≤ flagRateCap, default 5%) within a daily escalation budget is
flagged to tier 2, where the distiller judge (skill_distiller.py) runs.

Tables: ``episodes`` + ``failure_fingerprints`` (migration 028). Fingerprints
are brain_query-searchable via the shared store helpers below — the earlier
draft's "add a memory section to the search tool" is CUT (2026-08-30).
Retention: 90-day prune, called from the consolidation sweep (OQ 6 default).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, cast

from app.json_narrowing import as_int
from app.services.memory_conn import conn as _conn

logger = logging.getLogger(__name__)

# OQ 6 recommended default: 90-day episode retention (turn_outcomes keeps 30).
EPISODE_RETENTION_DAYS = 90
# Cost gate: at most this fraction of scored episodes is flagged to tier 2.
DEFAULT_FLAG_RATE_CAP = 0.05
# Daily budget on tier-2 escalations (config escalationBudgetPerDay).
DEFAULT_ESCALATION_BUDGET_PER_DAY = 2
# Paraphrase-level dedupe threshold — the consolidation merge constant.
_FINGERPRINT_SIMILARITY = 0.85
_MAX_EXCERPT = 240

_STOPWORDS = frozenset(
    'a an and are as at be but by for from had has have i in is it its of on '
    'or that the this to was were will with you your me my we our not do does '
    'did can could should would error failed failure'.split()
)

# ── typed event detection (deterministic regexes over stored text) ─────

_CORRECTION_RE = re.compile(
    r"\b(?:actually|correction)\b|\bthat(?:'s| is) (?:wrong|incorrect|not right)\b"
    r'|\bI meant\b|\bno,? (?:not|use|try|do)\b|\bdon\'?t\b|\bnever mind\b',
    re.IGNORECASE,
)
_RESCUE_RE = re.compile(
    r"\bI (?:fixed|did|installed|added|created) it\b|\bmy bad\b|\bturns out I\b"
    r'|\bI did it myself\b|\bsorry,? (?:that|it) was (?:my|me)\b',
    re.IGNORECASE,
)
_ABANDON_RE = re.compile(
    r"\blet'?s (?:try|go) (?:a )?different\b|\bforget (?:that|this) approach\b"
    r'|\bscrap that\b|\bdifferent approach\b|\bstart over\b|\bstep back\b'
    r'|\bthat approach (?:isn.t|is not) working\b',
    re.IGNORECASE,
)
_TOOL_ERROR_RE = re.compile(
    r'\[Validation Error\]|\[Error\]|\bexit code:?[1-9]|\btraceback\b'
    r'|\bcommand failed\b|\btool (?:error|failed)\b',
    re.IGNORECASE,
)


def _messageText(content: object) -> str:
    """Flatten a stored message content to text.

    §12 F-1: the workbench persistence path stores assistant/tool messages
    as JSON DICTS (``{"content": ..., "tool_calls": [...]}`` —
    memory_store/sessions.py) and tool results as role='tool' dicts. The
    old flatten handled str + block-list only, so every dict-shaped message
    read as empty and the miner mined nothing from real transcripts.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get('text'), str):
                parts.append(str(block['text']))
        return '\n'.join(parts)
    if isinstance(content, dict):
        parts = []
        inner = content.get('content')
        if isinstance(inner, str):
            parts.append(inner)
        elif inner:
            parts.append(_messageText(inner))
        for tc in content.get('tool_calls') or []:
            if not isinstance(tc, dict):
                continue
            fnRaw = tc.get('function')
            fn = fnRaw if isinstance(fnRaw, dict) else {}
            name = str(fn.get('name') or tc.get('name') or '')
            args = str(fn.get('arguments') or tc.get('input') or '')
            if name:
                parts.append(f'{name} {args[:200]}'.strip())
        return '\n'.join(p for p in parts if p)
    return ''


def _loadContent(raw: object) -> object:
    """Parse a stored content column; raw text passes through (§12 F-2 —
    the app itself writes non-JSON rows, e.g. [Proxy Self-Heal] nudges)."""
    s = str(raw if raw is not None else '')
    if not s:
        return ''
    try:
        return json.loads(s)
    except Exception:
        return s


# §12 F-11: machine-injected user-role blocks (harness plumbing, not the
# human talking). Mining them as corrections/rescues/abandons is noise.
_INJECTION_PREFIXES = (
    '[SUBAGENT RESULTS',
    '[SUBAGENT_COMPLETE',
    '[Proxy Self-Heal]',
    '[SYSTEM:',
    '[SYSTEM_INJECTION',
    '<memory_nudge',
)


def _isMachineInjected(text: str) -> bool:
    stripped = text.lstrip()
    return any(stripped.startswith(p) for p in _INJECTION_PREFIXES)


# ── window extraction (Phase A) ─────────────────────────────────────────


def _extractEvents(role: str, text: str) -> list[dict[str, str]]:
    """Typed events observable in one stored message.

    §12 F-1: tool-role messages are where error receipts actually live in
    real transcripts (assistant-role hits are rare — the model narrates,
    the tool result carries the failure). Both roles are scanned now.
    """
    events: list[dict[str, str]] = []
    stripped = text.strip()
    if not stripped:
        return events
    if role in ('assistant', 'tool') and _TOOL_ERROR_RE.search(stripped):
        events.append(
            {
                'type': 'tool_error',
                'excerpt': stripped[:_MAX_EXCERPT],
            }
        )
    if role != 'user' or _isMachineInjected(stripped):
        # §12 F-11: harness-injected user-role blocks are not human speech.
        return events
    if _CORRECTION_RE.search(stripped):
        events.append({'type': 'user_correction', 'excerpt': stripped[:_MAX_EXCERPT]})
    if _RESCUE_RE.search(stripped):
        events.append({'type': 'user_rescue', 'excerpt': stripped[:_MAX_EXCERPT]})
    if _ABANDON_RE.search(stripped):
        events.append({'type': 'abandoned_approach', 'excerpt': stripped[:_MAX_EXCERPT]})
    return events


def _innerText(content: object) -> str:
    """The assistant's own prose only (tool-call payloads excluded) — used
    to decide whether a message is a CLEAN continuation of the turn."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        inner = content.get('content')
        return inner.strip() if isinstance(inner, str) else ''
    if isinstance(content, list):
        return '\n'.join(
            str(b.get('text')) for b in content if isinstance(b, dict) and isinstance(b.get('text'), str)
        ).strip()
    return ''


def extract_episodes(sessionId: str) -> list[dict[str, Any]]:
    """Mine one session's stored transcript into episode windows.

    Three window shapes (plan §3.1):
      * failure_recovery  — tool/assistant error → later clean continuation
        (resolved), user rescue (rescued), or session end (unresolved)
      * correction_accepted — user correction → assistant reply with no
        immediate re-correction
      * abandoned_approach — user abandon marker → continuation
    """
    rows = _conn().execute(
        'SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id',
        (sessionId,),
    ).fetchall()
    # §12 F-2: content is parsed defensively — raw-text rows are real
    # (sessions.py stores str payloads verbatim) and must never abort mining.
    parsed = [_loadContent(r['content']) for r in rows]
    msgs: list[tuple[int, str, str]] = [
        (int(r['id']), str(r['role']), _messageText(p)) for r, p in zip(rows, parsed)
    ]
    clean: list[bool] = [
        bool(_innerText(p)) and not _TOOL_ERROR_RE.search(_innerText(p)) for p in parsed
    ]
    episodes: list[dict[str, Any]] = []
    n = len(msgs)
    for i, (mid, role, text) in enumerate(msgs):
        events = _extractEvents(role, text)
        if not events:
            continue
        kinds = {e['type'] for e in events}
        if role in ('assistant', 'tool') and 'tool_error' in kinds:
            # failure_recovery: scan forward to the first assistant message
            # carrying real prose (a tool-call-only retry is NOT recovery),
            # or a rescue marker.
            outcome = 'unresolved'
            end = mid
            for j in range(i + 1, n):
                _, r2, t2 = msgs[j]
                if r2 == 'user' and _RESCUE_RE.search(t2) and not _isMachineInjected(t2):
                    outcome = 'rescued'
                    end = msgs[j][0]
                    break
                if r2 == 'assistant' and clean[j]:
                    outcome = 'resolved'
                    end = msgs[j][0]
                    break
                if r2 == 'user' and _ABANDON_RE.search(t2) and not _isMachineInjected(t2):
                    outcome = 'unresolved'
                    end = msgs[j][0]
                    break
            episodes.append(
                {
                    'kind': 'failure_recovery',
                    'start_message_id': mid,
                    'end_message_id': end,
                    'events': events,
                    'outcome': outcome,
                }
            )
        elif role == 'user' and 'user_correction' in kinds:
            # correction_accepted: an assistant reply follows and the user
            # does not immediately re-correct (within the next 2 user turns).
            assistantReplied = any(r2 == 'assistant' for _, r2, _ in msgs[i + 1 : i + 3])
            reCorrections = sum(
                1
                for _, r2, t2 in msgs[i + 1 : i + 6]
                if r2 == 'user' and not _isMachineInjected(t2) and _CORRECTION_RE.search(t2)
            )
            episodes.append(
                {
                    'kind': 'correction_accepted',
                    'start_message_id': mid,
                    'end_message_id': next((m for m, r2, _ in msgs[i + 1 :] if r2 == 'assistant'), mid),
                    'events': events,
                    'outcome': 'resolved' if (assistantReplied and reCorrections == 0) else 'unresolved',
                }
            )
        elif role == 'user' and 'abandoned_approach' in kinds:
            # abandoned_approach: the pivot itself is the window; whether the
            # session continued cleanly after decides the outcome.
            continued = any(r2 == 'assistant' for _, r2, _ in msgs[i + 1 :])
            episodes.append(
                {
                    'kind': 'abandoned_approach',
                    'start_message_id': mid,
                    'end_message_id': next((m for m, r2, _ in msgs[i + 1 :] if r2 == 'assistant'), mid),
                    'events': events,
                    'outcome': 'resolved' if continued else 'unresolved',
                }
            )
    return episodes


# ── fingerprints (Phase B) ───────────────────────────────────────────────

_SLUG_RE = re.compile('[a-z0-9]+')


def _keyTokens(text: str, cap: int = 3) -> list[str]:
    """Normalized key tokens: slug-cased, stopword-stripped, by frequency —
    ties broken by FIRST occurrence (the subject words come first, and
    first-occurrence order keeps signatures stable across rewordings)."""
    counts: dict[str, int] = {}
    order: dict[str, int] = {}
    for idx, tok in enumerate(_SLUG_RE.findall((text or '').lower())):
        if len(tok) < 3 or tok in _STOPWORDS:
            continue
        if tok not in order:
            order[tok] = idx
        counts[tok] = counts.get(tok, 0) + 1
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], order[kv[0]]))
    return [t for t, _ in ordered[:cap]]


def _causeClass(events: list[dict[str, Any]]) -> str:
    """Coarse cause class for a window (error-class discipline, generalized)."""
    kinds = [str(e.get('type')) for e in events]
    if 'user_rescue' in kinds:
        return 'user-rescue'
    if any(str(e.get('type')) == 'tool_error' for e in events):
        return 'tool-error'
    if 'abandoned_approach' in kinds:
        return 'abandoned-approach'
    if 'user_correction' in kinds:
        return 'user-correction'
    return 'other'


def fingerprint_for(episode: dict[str, Any]) -> str:
    """``cause-class:token`` signature — the canonical shape is
    ``missing-binary:ngspice``; here e.g. ``tool-error:ngspice-install``."""
    cause = _causeClass(episode.get('events') or [])
    excerpt = ' '.join(
        str(e.get('excerpt', '')) for e in episode.get('events') or []
    )
    tokens = _keyTokens(excerpt)
    return f"{cause}:{'-'.join(tokens) if tokens else 'general'}"


def upsert_fingerprint(fp: str) -> dict[str, Any]:
    """Insert or increment one fingerprint; returns its row."""
    conn = _conn()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO failure_fingerprints (fingerprint, episode_count, first_seen, last_seen, status)
        VALUES (?, 1, ?, ?, 'open')
        ON CONFLICT(fingerprint) DO UPDATE SET
          episode_count = episode_count + 1,
          last_seen = excluded.last_seen
        """,
        (fp, now, now),
    )
    conn.commit()
    row = conn.execute(
        'SELECT * FROM failure_fingerprints WHERE fingerprint = ?', (fp,)
    ).fetchone()
    return dict(row) if row else {}


def paraphrase_dedupe(fp: str, text: str, existing: list[tuple[str, str]]) -> str:
    """Collapse a near-duplicate fingerprint onto an existing signature.

    ``existing`` is (fingerprint, excerpt-text) pairs for the workspace's
    recent fingerprints. Two paraphrases converge when (a) the raw texts
    hit the consolidation merge threshold (≥0.85 BM25 — near-verbatim
    repeats) OR (b) the new signature's key tokens are CONTAINED in the
    existing signature's tokens — the fingerprint-space shape of "same
    failure, reworded".
    """
    cause, _, tokens = fp.partition(':')
    newTokens = set(tokens.split('-'))
    for otherFp, otherText in existing:
        otherCause, _, otherTokens = otherFp.partition(':')
        if otherCause != cause:
            continue  # different cause classes never merge
        if otherTokens and newTokens and set(otherTokens.split('-')).issubset(newTokens):
            return otherFp
        if otherText:
            from app.services.text_similarity import similarity

            if similarity(text, otherText) >= _FINGERPRINT_SIMILARITY:
                return otherFp
    return fp


# ── storage helpers ──────────────────────────────────────────────────────


def save_episode(episode: dict[str, Any]) -> int:
    """Persist one mined episode (deduped on session+window)."""
    conn = _conn()
    row = conn.execute(
        'SELECT id FROM episodes WHERE session_id = ? AND start_message_id = ? AND kind = ?',
        (
            str(episode.get('session_id', '')),
            int(episode.get('start_message_id', 0)),
            str(episode.get('kind', '')),
        ),
    ).fetchone()
    now = datetime.now(timezone.utc).isoformat()
    if row:
        return int(row['id'])
    cur = conn.execute(
        """
        INSERT INTO episodes (session_id, kind, start_message_id, end_message_id,
                              events, outcome, fingerprint_id, tier, scope, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """,
        (
            str(episode.get('session_id', '')),
            str(episode.get('kind', '')),
            int(episode.get('start_message_id', 0)),
            int(episode.get('end_message_id', 0)),
            json.dumps(episode.get('events') or [], ensure_ascii=False),
            str(episode.get('outcome', 'unresolved')),
            str(episode.get('fingerprint_id', '')),
            str(episode.get('scope', '') or ''),
            now,
        ),
    )
    conn.commit()
    return int(as_int(cur.lastrowid, 0))


def _episodeExists(episode: dict[str, Any]) -> bool:
    """True when the (session, window, kind) episode is already stored —
    §12 F-6: re-mining the same window must not re-upsert its fingerprint
    (every 24h pass was inflating episode_count and bumping last_seen,
    faking recurrence and churning resolution state)."""
    return (
        _conn()
        .execute(
            'SELECT 1 FROM episodes WHERE session_id = ? AND start_message_id = ? AND kind = ?',
            (
                str(episode.get('session_id', '')),
                int(episode.get('start_message_id', 0)),
                str(episode.get('kind', '')),
            ),
        )
        .fetchone()
        is not None
    )


def _existingFingerprintTexts(limit: int = 25) -> list[tuple[str, str]]:
    """(fingerprint, excerpt-text) pairs for paraphrase dedupe, rebuilt from
    the episodes table. §12 F-6 (related): record_episode used to read a
    nonexistent ``last_excerpt`` column, so only the token-containment
    dedupe lane ever ran."""
    out: list[tuple[str, str]] = []
    for r in _conn().execute(
        """
        SELECT fingerprint_id, events FROM episodes
        WHERE fingerprint_id != ''
        GROUP BY fingerprint_id HAVING MAX(id)
        ORDER BY MAX(id) DESC LIMIT ?
        """,
        (int(limit),),
    ).fetchall():
        try:
            events = json.loads(str(r['events']))
        except Exception:
            events = []
        out.append((str(r['fingerprint_id']), _episodeText({'events': events})))
    return out


def record_episode(episode: dict[str, Any], existingFingerprints: list[tuple[str, str]] | None = None) -> int:
    """Fingerprint + dedupe + persist one episode. Returns the episode id."""
    fp = fingerprint_for(episode)
    if existingFingerprints is None:
        existingFingerprints = _existingFingerprintTexts()
    fp = paraphrase_dedupe(fp, _episodeText(episode), existingFingerprints)
    episode = {**episode, 'fingerprint_id': fp}
    isNew = not _episodeExists(episode)
    episodeId = save_episode(episode)
    if isNew:
        upsert_fingerprint(fp)
    return episodeId


def _episodeText(episode: dict[str, Any]) -> str:
    return ' '.join(str(e.get('excerpt', '')) for e in episode.get('events') or [])


def recent_fingerprints(limit: int = 25) -> list[dict[str, Any]]:
    rows = _conn().execute(
        'SELECT * FROM failure_fingerprints ORDER BY last_seen DESC LIMIT ?',
        (int(limit),),
    ).fetchall()
    return [dict(r) for r in rows]


def _parseEpisodeRow(row: Any) -> dict[str, Any]:
    """DB row → dict with ``events`` parsed from its JSON column."""
    ep = dict(row)
    try:
        ep['events'] = json.loads(str(ep.get('events') or '[]'))
    except Exception:
        ep['events'] = []
    return ep


def unscored_episodes(limit: int = 200) -> list[dict[str, Any]]:
    """Tier-1 episodes that have not been scored yet (no tier-1 result).

    §12 F-3: the rubric result lives in ``tier1_result`` — the tier-2
    ``judge_verdict`` column must stay empty until the distiller judges, or
    the distiller's unjudged selector is empty by construction."""
    rows = _conn().execute(
        """
        SELECT * FROM episodes
        WHERE tier = 1 AND tier1_result IS NULL
        ORDER BY id DESC LIMIT ?
        """,
        (int(limit),),
    ).fetchall()
    return [_parseEpisodeRow(r) for r in rows]


def flagged_episodes(limit: int = 50) -> list[dict[str, Any]]:
    rows = _conn().execute(
        'SELECT * FROM episodes WHERE tier = 2 ORDER BY id DESC LIMIT ?',
        (int(limit),),
    ).fetchall()
    return [dict(r) for r in rows]


def set_flagged(episodeId: int, flagged: bool) -> None:
    conn = _conn()
    conn.execute('UPDATE episodes SET tier = ? WHERE id = ?', (2 if flagged else 1, int(episodeId)))
    conn.commit()


def set_judge_verdict(episodeId: int, verdict: str) -> None:
    conn = _conn()
    conn.execute(
        'UPDATE episodes SET judge_verdict = ?, tier = 2 WHERE id = ?',
        (verdict, int(episodeId)),
    )
    conn.commit()


# ── tier-1 rubric (Phase B, deterministic) ───────────────────────────────

# Six fixed criteria (plan §3.2). Weights sum to 1.0; each subscore ∈ [0, 1].
_RUBRIC_WEIGHTS = {
    'completion': 0.25,
    'recurrence': 0.25,
    'correctionCount': 0.15,
    'recoveryQuality': 0.15,
    'causeStability': 0.10,
    'generalizability': 0.10,
}

_PROJECT_SPECIFIC_RE = re.compile(
    r'\b(?:C:\\|/home/|/Users/|C:/)[^\s]+|\b[a-z]+_[a-z]+\b', re.IGNORECASE
)


def score_episode(episode: dict[str, Any], fingerprintCount: int, sameCauseSessions: int) -> dict[str, Any]:
    """The six fixed rubric criteria — no LLM (plan §3.2).

    Returns per-criterion subscores plus the weighted total. Higher =
    more worth escalating: resolved windows with recurring stable causes
    that generalize beyond one project.
    """
    outcome = str(episode.get('outcome', 'unresolved'))
    events = list(episode.get('events') or [])
    text = _episodeText(episode)

    completion = {'resolved': 1.0, 'rescued': 0.5}.get(outcome, 0.0)
    # Window length is the recovery-cost proxy: fewer messages to get back
    # to a clean state = better recovery quality.
    span = max(1, int(episode.get('end_message_id', 0)) - int(episode.get('start_message_id', 0)) + 1)
    recoveryQuality = max(0.0, 1.0 - (span - 1) / 10.0)
    correctionCount = max(0.0, 1.0 - sum(1 for e in events if e.get('type') == 'user_correction') / 3.0)
    recurrence = min(1.0, max(0, fingerprintCount - 1) / 3.0)
    causeStability = min(1.0, max(0, sameCauseSessions - 1) / 3.0)
    generalizability = 0.0 if _PROJECT_SPECIFIC_RE.search(text) else 1.0

    subscores = {
        'completion': completion,
        'correctionCount': correctionCount,
        'recurrence': recurrence,
        'recoveryQuality': recoveryQuality,
        'causeStability': causeStability,
        'generalizability': generalizability,
    }
    total = sum(_RUBRIC_WEIGHTS[k] * v for k, v in subscores.items())
    return {'score': round(total, 4), 'subscores': subscores, 'weights': dict(_RUBRIC_WEIGHTS)}


def _sameCauseSessions(fp: str) -> int:
    row = _conn().execute(
        'SELECT COUNT(DISTINCT session_id) AS n FROM episodes WHERE fingerprint_id = ?',
        (fp,),
    ).fetchone()
    return int(row['n']) if row else 0


def flag_top_slice(
    flagRateCap: float = DEFAULT_FLAG_RATE_CAP,
    budgetPerDay: int = DEFAULT_ESCALATION_BUDGET_PER_DAY,
) -> dict[str, int]:
    """Score unscored tier-1 episodes, then flag the top slice to tier 2.

    Cost gate (plan §3.2): at most ``flagRateCap`` of scored episodes and
    at most ``budgetPerDay`` per pass, recurrence-ranked. Flagged
    fingerprints flip ``flagged = 1`` so the distiller can find them.
    """
    conn = _conn()
    episodes = unscored_episodes()
    if not episodes:
        return {'scored': 0, 'flagged': 0}
    scored: list[tuple[float, dict[str, Any]]] = []
    for ep in episodes:
        fp = str(ep.get('fingerprint_id') or '')
        fpRow = conn.execute(
            'SELECT episode_count FROM failure_fingerprints WHERE fingerprint = ?', (fp,)
        ).fetchone()
        fpCount = int(fpRow['episode_count']) if fpRow else 1
        result = score_episode(ep, fpCount, _sameCauseSessions(fp))
        # §12 F-3: the tier-1 rubric is NOT a judge verdict — writing it into
        # judge_verdict made the distiller's unjudged set always empty.
        conn.execute(
            "UPDATE episodes SET tier1_result = ? WHERE id = ?",
            (json.dumps({'tier1': result}, ensure_ascii=False), int(ep['id'])),
        )
        scored.append((result['score'], ep))
    conn.commit()

    scored.sort(key=lambda pair: (-pair[0], -int(pair[1].get('id', 0))))
    # 2.14 (Part 25): floor at 1 when there are candidates — int(len*cap)
    # rounded to 0 for any pass with <20 unscored episodes, so typical desktop
    # installs NEVER escalated anything to tier-2 review.
    capCount = int(len(scored) * max(0.0, min(1.0, flagRateCap)))
    if scored and capCount < 1:
        capCount = 1
    flaggedCount = 0
    for score, ep in scored:
        if flaggedCount >= budgetPerDay or flaggedCount >= capCount:
            break
        if score <= 0:
            break
        set_flagged(int(ep['id']), True)
        fp = str(ep.get('fingerprint_id') or '')
        if fp:
            conn.execute(
                'UPDATE failure_fingerprints SET flagged = 1 WHERE fingerprint = ?', (fp,)
            )
            conn.commit()
        flaggedCount += 1
    return {'scored': len(scored), 'flagged': flaggedCount}


# ── scheduled pass + retention ───────────────────────────────────────────


def mine_sessions(sinceDays: int = 30) -> dict[str, int]:
    """Extract episodes from recent sessions (the scheduled Phase A pass)."""
    since = (datetime.now(timezone.utc) - timedelta(days=sinceDays)).isoformat()
    # 2.17 (Part 25): created_at is stored space-separated (datetime('now'))
    # while `since` is ISO with a 'T'; a raw string compare sorts ' ' (0x20)
    # before 'T' and drops the whole cutoff day. julianday() parses both.
    rows = _conn().execute(
        """
        SELECT DISTINCT session_id AS sid FROM messages
        WHERE julianday(created_at) IS NOT NULL
          AND julianday(created_at) >= julianday(?)
        """,
        (since,),
    ).fetchall()
    existing = _existingFingerprintTexts(limit=1000)
    extracted = 0
    for r in rows:
        # Part 26 6.4: stamp each episode with the source session's M-2 scope
        # ('' = global). A Bot's private home-chat episodes must not later
        # surface as globally injected <memory> lessons in every session —
        # the leak class the remember/forget doors closed, via the side door.
        scope = ''
        try:
            from app.services import session_scope as _ss
            from app.services.workbench.sessions import get_workbench_session

            sess = get_workbench_session(str(r['sid']))
            if sess is not None:
                scope = str(_ss.resolve_scope(sess) or '')
        except Exception:
            scope = ''
        for episode in extract_episodes(str(r['sid'])):
            episode['session_id'] = str(r['sid'])
            episode['scope'] = scope
            isNew = not _episodeExists(episode)
            record_episode(episode, existingFingerprints=existing)
            if isNew:
                extracted += 1
    return {'sessions': len(rows), 'episodes': extracted}


def prune_old_episodes(days: int = EPISODE_RETENTION_DAYS) -> int:
    """OQ 6 default: 90-day prune, called from the consolidation sweep."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    conn = _conn()
    cur = conn.execute('DELETE FROM episodes WHERE created_at < ?', (cutoff,))
    conn.commit()
    return int(cur.rowcount)


def learning_report() -> dict[str, Any]:
    """Counters for the Phase E skillLearningReport blob."""
    conn = _conn()
    counts = {
        'episodes': int(conn.execute('SELECT COUNT(*) AS n FROM episodes').fetchone()['n']),
        'tier2': int(conn.execute('SELECT COUNT(*) AS n FROM episodes WHERE tier = 2').fetchone()['n']),
        'judged': int(
            conn.execute(
                "SELECT COUNT(*) AS n FROM episodes WHERE tier = 2 AND judge_verdict IS NOT NULL"
            ).fetchone()['n']
        ),
        'fingerprints': int(conn.execute('SELECT COUNT(*) AS n FROM failure_fingerprints').fetchone()['n']),
        'flaggedFingerprints': int(
            conn.execute('SELECT COUNT(*) AS n FROM failure_fingerprints WHERE flagged = 1').fetchone()['n']
        ),
        'resolvedFingerprints': int(
            conn.execute(
                "SELECT COUNT(*) AS n FROM failure_fingerprints WHERE status = 'resolved'"
            ).fetchone()['n']
        ),
    }
    return cast(dict[str, Any], counts)


# ── Phase E: resolution check + demotion (suggestion-only, OQ 5) ─────────

_RESOLUTION_WINDOW_DAYS = 30


def _fingerprintSkillMap() -> dict[str, str]:
    """fingerprint → skill name, from APPLIED skill proposals that carry
    payload.fingerprint (the distiller stamps it at propose time)."""
    out: dict[str, str] = {}
    try:
        from app.services.harness_self_improve import list_proposals

        for p in list_proposals():
            if p.get('status') != 'applied':
                continue
            payload = p.get('payload')
            if not isinstance(payload, dict):
                continue
            fp = str(payload.get('fingerprint', '')).strip()
            name = str(payload.get('name', '')).strip()
            if fp and name and str(p.get('kind', '')).startswith('skill_'):
                out.setdefault(fp, name)
    except Exception:
        pass
    return out


def _skillLoadCount(skillName: str) -> int:
    try:
        import json as _json

        from app.services.skill_service import _agentSkillsDir

        sidecar = _agentSkillsDir() / skillName / '.usage.json'
        if not sidecar.exists():
            return 0
        data = _json.loads(sidecar.read_text('utf-8'))
        return int(data.get('count') or 0)
    except Exception:
        return 0


def run_resolution_check(windowDays: int = _RESOLUTION_WINDOW_DAYS) -> dict[str, Any]:
    """Phase E measurement (plan §3.5).

    A shipped skill's fingerprint is monitored: 0 recurrences for the
    window → ``resolved``; a RESOLVED fingerprint that recurs re-flags and
    drafts a revision-or-retire suggestion; a shipped skill with ZERO loads
    and no recurrence drafts a demotion (skill_delete) proposal — all
    suggestion-only, human-approved, never auto-deleted (OQ 5 default)."""
    from datetime import datetime, timedelta, timezone

    conn = _conn()
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=windowDays)).isoformat()
    skillByFp = _fingerprintSkillMap()
    resolvedCount = 0
    recurredCount = 0
    demotionCount = 0

    for fpRow in recent_fingerprints(limit=200):
        fp = str(fpRow['fingerprint'])
        status = str(fpRow.get('status') or 'open')
        lastSeen = str(fpRow.get('last_seen') or '')
        skill = skillByFp.get(fp, '')
        if not skill:
            continue
        stale = bool(lastSeen) and lastSeen < cutoff
        if status in ('open', 'skill_drafted') and stale:
            conn.execute(
                "UPDATE failure_fingerprints SET status = 'resolved' WHERE fingerprint = ?", (fp,)
            )
            conn.commit()
            status = 'resolved'  # downstream demotion check sees the update
            resolvedCount += 1
        elif status == 'resolved' and not stale:
            # Recurrence after resolution: re-flag + revision-or-retire
            # suggestion (observation — a human decides revise vs retire).
            conn.execute(
                "UPDATE failure_fingerprints SET status = 'open', flagged = 1 WHERE fingerprint = ?",
                (fp,),
            )
            conn.commit()
            recurredCount += 1
            _file_suggestion(
                kind='observation',
                problem=f'Recurrence after resolution for {skill!r} (fingerprint {fp})',
                evidence=f'fingerprint {fp} recurred at {lastSeen} after being resolved',
                proposal=(
                    f'The fingerprint {skill!r} was distilled from recurred. Revise the skill '
                    '(skill_patch proposal) or retire it — human decision.'
                ),
                payload={'fingerprint': fp, 'action': 'revise_or_retire', 'target': skill, 'origin': 'distilled'},
            )
        if status == 'resolved' and stale and _skillLoadCount(skill) == 0:
            # Zero loads + no recurrence in the window → demotion SUGGESTION.
            filed = _file_suggestion(
                kind='skill_delete',
                problem=f'Demotion suggestion for {skill!r}: zero loads, no recurrence in {windowDays}d',
                evidence=f'fingerprint {fp} resolved; usage sidecar count = 0',
                proposal=f'Disable/delete skill {skill!r} (human-approved; nothing auto-deletes).',
                payload={'name': skill, 'fingerprint': fp, 'action': 'demote', 'target': skill, 'origin': 'distilled'},
            )
            if filed:
                demotionCount += 1
    return {'resolved': resolvedCount, 'recurred': recurredCount, 'demotionSuggestions': demotionCount}


def set_fingerprint_status(fp: str, status: str) -> None:
    """§12 F-10: the advertised statuses (open | skill_drafted | resolved |
    retired) must actually be written. ``skill_drafted`` is set when a
    distilled draft files; ``retired`` when the fingerprint's skill_delete
    applies (from ANY prior state — demotions flow from resolved). A draft
    never resurrects a resolved fingerprint to drafted."""
    if not fp:
        return
    conn = _conn()
    if status == 'retired':
        conn.execute(
            'UPDATE failure_fingerprints SET status = ? WHERE fingerprint = ?',
            (str(status), str(fp)),
        )
    else:
        conn.execute(
            "UPDATE failure_fingerprints SET status = ? WHERE fingerprint = ? AND status = 'open'",
            (str(status), str(fp)),
        )
    conn.commit()


def _file_suggestion(**kw: Any) -> bool:
    """File a suggestion proposal, deduped on (fingerprint, action, target).
    Returns True only when a proposal was actually filed — dedupe (including
    §12 F-8 rejected-draft suppression) reports False so callers must not
    count a skipped suggestion."""
    try:
        from app.services.harness_self_improve import save_proposal

        payload = kw.get('payload') or {}
        from app.services.skill_distiller import _draftExists

        if _draftExists(
            str(payload.get('fingerprint', '')),
            str(payload.get('action', '')),
            str(payload.get('target', '')),
        ):
            return False
        save_proposal(
            problem=str(kw.get('problem', '')),
            evidence=str(kw.get('evidence', '')),
            proposal=str(kw.get('proposal', '')),
            rollback='reject the proposal — nothing has changed yet (suggestion-only).',
            kind=str(kw.get('kind', 'observation')),
            payload=payload,
        )
        return True
    except Exception as exc:
        logger.debug('suggestion filing failed: %s', exc)
        return False
