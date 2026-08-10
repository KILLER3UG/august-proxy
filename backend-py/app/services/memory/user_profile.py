"""User profile consolidation — a durable summary of who the user is.

The background reflection extracts stable facts each review cycle; this module
folds them into a single ``userProfile`` KV blob so a new chat does not
cold-start. Replacement is near-dup aware: repeated facts refresh their
timestamp instead of accumulating twins, and the blob stays capped.

Shape::

    {
      'summary': str,
      'facts': [{fact, field, updated_at, source}],
      'communication_style': str | None,   # concise | balanced | detailed | casual | technical
      'updated_at': float,
    }

The ``summary`` line is rendered into the Tier 1 ``<user_profile>`` prompt
block; ``facts`` power the Brain UI / context_read tool. Preferences are
also captured deterministically from user messages (``capture_preferences``)
so "I prefer X" is remembered the same turn, no LLM required.
"""

from __future__ import annotations

import re
import time
from typing import cast

from app.json_narrowing import as_dict, as_list, as_str
from app.services.memory_store import get_memory, save_memory
from app.type_aliases import JsonValue

_PROFILE_KEY = 'userProfile'
_MAX_PROFILE_FACTS = 25
_NEAR_DUP_THRESHOLD = 0.85
# Facts older than this are kept in the store but excluded from the prompt
# block (stale preferences must not steer a fresh chat).
_STALE_FACT_AGE_S = 180 * 24 * 3600

_STACK_HINTS = (
    'python', 'typescript', 'javascript', 'node', 'react', 'vue', 'angular',
    'go ', 'rust', 'java', 'c#', 'c++', 'sql', 'postgres', 'mysql', 'sqlite',
    'mongodb', 'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'fastapi',
    'django', 'flask', 'tauri', 'electron', 'expo', 'react native', 'php',
    'ruby', 'git', 'linux', 'windows', 'macos', 'grafana', 'terraform',
)
_PREFERENCE_HINTS = ('prefer', 'prefers', 'always', 'never', 'favorite', 'favourite', "don't", 'do not')
_ROLE_HINTS = ('i am', "i'm", 'user is', 'works as', 'developer', 'engineer', 'designer', 'student')

# Direct-capture preference patterns (deterministic, no LLM): "i prefer X",
# "i like X", "my favorite X is Y", "i always/usually X", "never X".
_PREFERENCE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bi (?:would )?prefer (?:to use |using |working with |to work with )?([^.,;!?]{2,60})", re.I), 'prefers'),
    (re.compile(r"\bi (?:really |quite |definitely )?like (?:to use |using |working with )?([^.,;!?]{2,60})", re.I), 'likes'),
    (re.compile(r"\bmy favorite (?:[a-z ]+ )?(?:is|are) ([^.,;!?]{2,60})", re.I), 'favorite'),
    (re.compile(r"\bi (?:always|usually|typically|normally) ([^.,;!?]{2,60})", re.I), 'habit'),
    (re.compile(r"\bplease (?:do not|don't|never) ([^.,;!?]{2,60})", re.I), 'avoid'),
    (re.compile(r"\bi(?:'d| would) rather (?:you |that you )?(?:not |never )?([^.,;!?]{2,60})", re.I), 'prefers'),
)
_TECH_TERMS_RE = re.compile(
    r'\b(code|python|javascript|typescript|api|deploy|docker|test|build|refactor|backend|frontend|'
    r'sql|database|pipeline|ci|debug|function|component)\b', re.I)
_CASUAL_RE = re.compile(r'[\U0001F300-\U0001FAFF]|\b(hey|hi|yeah|ok|sure|thanks|thx|btw|imo|tbh)\b', re.I)


def _normalize_text(text: object) -> str:
    """Lowercase and collapse punctuation/whitespace — basis for near-dup checks."""
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', str(text or '').lower()).split())


def _similarity(a: object, b: object) -> float:
    """Token-overlap similarity in [0, 1]; 1.0 when one text covers the other.

    Short inputs (fewer than 3 tokens) score 0 — a single shared token like
    "python" must never absorb an unrelated longer memory.
    """
    ta = set(_normalize_text(a).split())
    tb = set(_normalize_text(b).split())
    if not ta or not tb:
        return 0.0
    if min(len(ta), len(tb)) < 3:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))


def _classify_fact(fact: str) -> str:
    """Bucket a stable fact into a profile field (name/role/stack/preference/other)."""
    low = fact.lower()
    # Name only when the fact is about the person, not a project/thing's name.
    if (
        len(low) < 60
        and 'project' not in low
        and ('my name' in low or 'name is' in low or 'call me' in low or 'user is named' in low)
    ):
        return 'name'
    if any(h in low for h in _STACK_HINTS):
        return 'stack'
    if any(h in low for h in _PREFERENCE_HINTS):
        return 'preference'
    if any(h in low for h in _ROLE_HINTS):
        return 'role'
    return 'other'


def _build_summary(facts: list[dict[str, object]]) -> str:
    """Render one compact summary line per profile field."""
    labels = {
        'name': 'Name',
        'role': 'Role',
        'stack': 'Stack',
        'preference': 'Preferences',
        'other': 'Other',
    }
    grouped: dict[str, list[str]] = {}
    for f in facts:
        field = as_str(f.get('field'), 'other')
        fact = as_str(f.get('fact'), '').strip()
        if fact:
            grouped.setdefault(field, []).append(fact)
    lines = []
    for field in ('name', 'role', 'stack', 'preference', 'other'):
        values = grouped.get(field)
        if values:
            lines.append(f'{labels[field]}: {"; ".join(values)}')
    return '\n'.join(lines)


def _read_profile() -> dict[str, object]:
    raw = get_memory(_PROFILE_KEY)
    if isinstance(raw, dict):
        return raw
    return {'summary': '', 'facts': [], 'updated_at': 0.0}


def _as_epoch(value: object) -> float:
    """Parse a stored timestamp (epoch float or ISO string) to epoch seconds.

    ``as_str`` only passes real strings, so float timestamps need their own
    reader (a '0' fallback made every fact look stale/old).
    """
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            pass
        try:
            from datetime import datetime

            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                return parsed.timestamp()
            return parsed.timestamp()
        except Exception:
            return 0.0
    return 0.0


def get_user_profile() -> dict[str, object]:
    """Public accessor: profile with stale facts filtered for prompt use."""
    profile = _read_profile()
    now = time.time()
    fresh = [
        f for f in as_list(profile.get('facts'), [])
        if (now - _as_epoch(as_dict(f).get('updated_at'))) < _STALE_FACT_AGE_S
    ]
    out = dict(profile)
    out['facts'] = fresh
    out['summary'] = _build_summary([as_dict(f) for f in fresh])
    return out


def capture_preferences(text: str) -> list[str]:
    """Deterministic preference capture: extract "I prefer X" style facts.

    Runs per user turn (no LLM); hits fold into the profile so the model
    knows the user's stated preferences even in a fresh session.
    """
    cleaned = as_str(text, '')
    hits: list[str] = []
    for pattern, kind in _PREFERENCE_PATTERNS:
        for m in pattern.finditer(cleaned):
            value = ' '.join(m.group(1).split())
            if not value or len(value) < 2:
                continue
            hits.append(f'{kind}: {value}')
    return hits


def note_user_message(text: str) -> list[str]:
    """Per-turn capture: fold deterministic preference hits into the profile.

    Called after every user turn (no LLM) so stated preferences are known
    even in a fresh session. Near-dup aware and capped like the reflection
    path. Returns the captured preference strings so the caller can surface
    an in-chat "August remembered" notice.
    """
    hits = capture_preferences(text)
    if hits:
        consolidateUserProfile(hits)
    return hits


def infer_communication_style(user_messages: list[str]) -> str | None:
    """Deterministic communication-style label from recent user messages."""
    texts = [as_str(t).strip() for t in user_messages if as_str(t).strip()]
    if not texts:
        return None
    words = [len(t.split()) for t in texts]
    avg = sum(words) / len(words)
    joined = ' '.join(texts)
    if _CASUAL_RE.search(joined) and avg <= 25:
        return 'casual'
    if _TECH_TERMS_RE.search(joined) and avg >= 15:
        return 'technical'
    if avg < 12:
        return 'concise'
    if avg > 40:
        return 'detailed'
    return 'balanced'


def consolidateUserProfile(new_facts: list[str]) -> dict[str, object] | None:
    """Fold stable facts into the user profile blob (near-dup aware, capped).

    Repeated facts refresh their timestamp instead of duplicating; the
    summary line is rebuilt so the Tier 1 prompt block stays compact.
    Returns the updated profile, or None when nothing changed.
    """
    cleaned = [as_str(f).strip() for f in new_facts if as_str(f).strip()]
    if not cleaned:
        return None
    profile = _read_profile()
    facts = as_list(profile.get('facts'), [])
    existing: list[dict[str, object]] = []
    for f in facts:
        d = as_dict(f)
        if d:
            existing.append(d)
    now = time.time()
    changed = False
    for fact in cleaned:
        dup: dict[str, object] | None = None
        for e in existing:
            if _similarity(fact, as_str(e.get('fact'), '')) >= _NEAR_DUP_THRESHOLD:
                dup = e
                break
        if dup is not None:
            old_ts = _as_epoch(dup.get('updated_at'))
            if now - old_ts > 3600:
                dup['updated_at'] = now
                changed = True
            continue
        existing.append({'fact': fact, 'field': _classify_fact(fact), 'updated_at': now})
        changed = True
    if not changed:
        return None
    # Cap: keep the most recently updated facts.
    existing.sort(key=lambda e: float(as_str(e.get('updated_at'), '0') or 0), reverse=True)
    existing = existing[:_MAX_PROFILE_FACTS]
    profile['facts'] = cast(JsonValue, existing)
    profile['summary'] = _build_summary(existing)
    profile['updated_at'] = now
    save_memory(_PROFILE_KEY, cast(JsonValue, profile))
    return profile
