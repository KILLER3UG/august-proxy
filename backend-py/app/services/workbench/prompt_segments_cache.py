"""Cache semi-stable system-prompt segments (not full turn prompts).

Caches:
  * skills catalogue text used by Tier 1 ``<capabilities>``
  * static clarify / bulk instruction blocks (constants)

Does **not** cache volatile Tier-3 pieces (recent messages, auto-memories,
daemon updates, todos). Tier1/Tier2 still use existing ``prompt_cache``.

Disable with env ``AUGUST_P1_PROMPT_CACHE=0`` to force a rebuild every turn
(useful for A/B latency measurements).
"""

from __future__ import annotations

import os
import threading
import time

_lock = threading.Lock()
_skills: tuple[float, str, str] | None = None  # (mono, manifest, capabilities_skills_inner)
_hits = 0
_misses = 0
_SKILLS_TTL = 30.0  # seconds — skills rarely change mid-session

CLARIFY_BLOCK = (
    '<clarify_policy>\n'
    'Clarifying questions when uncertain.\n'
    "When you are genuinely uncertain about the user's intent, requirements, or a decision "
    'that would change your approach, DO NOT guess or invent requirements. Instead, call the '
    '`submit_clarify` tool with a concise `question` (1-2 sentences) and up to 5 short `choices` '
    '(options the user can pick from). You may also pass a `questions` array to ask several '
    'related questions at once. The UI presents your choices as numbered options and adds its own '
    "free-text input for anything not covered, so do NOT include a 'something else' option yourself. "
    "Ask at most one round of clarifying questions unless the user's answer reveals new ambiguity. "
    'This applies in every guard mode, including plan mode.\n'
    '</clarify_policy>'
)

BULK_BLOCK = (
    '<bulk_tools>\n'
    'Bulk tools (prefer over N single calls).\n'
    'When the same operation applies to many items, use a bulk tool instead of repeating '
    'the single-item tool. Options:\n'
    '- `bulk` with `operation` = read_files | write_files | delete_sessions | rename_sessions | '
    'kill_daemons | fetch_urls | load_skills (pass the matching array field)\n'
    '- Or named tools: `read_files`, `write_files`, `delete_sessions`, `rename_sessions`, '
    '`kill_daemons`, `web_fetch_many`, `load_skills`\n'
    'Cap is 40 items per call. Confirm with the user before bulk deletes/writes.\n'
    'Bulk tools keep the caution level of their primary bucket (tool_read / tool_write / '
    'tool_destructive) — bulk is a tag, not an override of destructive-confirmation guidance.\n'
    '</bulk_tools>'
)


def enabled() -> bool:
    v = os.environ.get('AUGUST_P1_PROMPT_CACHE', '1').strip().lower()
    return v not in ('0', 'false', 'no', 'off')


def clear() -> None:
    """Global bust of the skills-segment cache.

    Global (not per-session) is acceptable here: August is single-user /
    local-desktop scale, and skill create/approve/patch/delete is infrequent
    enough that a full bust is simpler than scoped keys. Revisit scoped
    invalidation if evolving-skill creation frequency climbs enough to hurt
    cache hit rate.
    """
    global _skills, _hits, _misses
    with _lock:
        _skills = None
        _hits = 0
        _misses = 0


def stats() -> dict[str, object]:
    with _lock:
        return {
            'enabled': enabled(),
            'skills_cached': _skills is not None,
            'hits': _hits,
            'misses': _misses,
            'skills_ttl_s': _SKILLS_TTL,
        }


def get_skills_segments() -> tuple[str, str]:
    """Return (skills_manifest_lines, skills_inner_for_capabilities).

    The second value is the formatted skills catalogue body (no ``## Available Skills``
    markdown — capabilities live in Tier 1 XML).
    """
    global _skills, _hits, _misses
    if not enabled():
        return _build_skills_segments()
    now = time.monotonic()
    with _lock:
        if _skills is not None and (now - _skills[0]) < _SKILLS_TTL:
            _hits += 1
            return _skills[1], _skills[2]
        _misses += 1
    manifest, extra = _build_skills_segments()
    with _lock:
        _skills = (time.monotonic(), manifest, extra)
    return manifest, extra


def _build_skills_segments() -> tuple[str, str]:
    manifest = ''
    extra = ''
    try:
        from app.services import skill_service
        from app.services.memory.capabilities_prompt import format_skills_by_category

        cat = skill_service.catalogue()
        if not cat:
            return '', ''
        lines_m: list[str] = []
        for s in cat:
            desc = s.get('description', '')
            trigger = s.get('trigger', '')
            created = s.get('created_by', '')
            evolving = ' [evolving]' if created in ('agent', 'auto-gen') else ''
            entry = f'{s["name"]}{evolving}: {desc}' if desc else f'{s["name"]}{evolving}'
            if trigger:
                entry += f' (trigger: {trigger})'
            lines_m.append(entry)
        manifest = '\n'.join(lines_m)
        extra = format_skills_by_category(cat)
    except Exception:
        return '', ''
    return manifest, extra
