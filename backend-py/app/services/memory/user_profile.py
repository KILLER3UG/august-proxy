"""User profile consolidation — a durable summary of who the user is.

The background reflection extracts stable facts each review cycle; this module
folds them into a single ``userProfile`` KV blob so a new chat does not
cold-start. Replacement is near-dup aware: repeated facts refresh their
timestamp instead of accumulating twins, and the blob stays capped.

Shape: ``{'summary': str, 'facts': [{fact, field, updated_at}], 'updated_at': float}``
The ``summary`` line is rendered into the Tier 1 ``<user_state>`` prompt block;
``facts`` power the Brain UI / context_read tool.
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

_STACK_HINTS = (
    'python', 'typescript', 'javascript', 'node', 'react', 'vue', 'angular',
    'go ', 'rust', 'java', 'c#', 'c++', 'sql', 'postgres', 'mysql', 'sqlite',
    'mongodb', 'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'fastapi',
    'django', 'flask', 'tauri', 'electron', 'expo', 'react native', 'php',
    'ruby', 'git', 'linux', 'windows', 'macos', 'grafana', 'terraform',
)
_PREFERENCE_HINTS = ('prefer', 'prefers', 'always', 'never', 'favorite', 'favourite', "don't", 'do not')
_ROLE_HINTS = ('i am', "i'm", 'user is', 'works as', 'developer', 'engineer', 'designer', 'student')


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
            old_ts = float(as_str(dup.get('updated_at'), '0') or 0)
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
