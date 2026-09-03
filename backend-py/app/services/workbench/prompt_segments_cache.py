"""Semi-stable system-prompt segment constants (not full turn prompts).

Holds the static clarify / bulk / web / memory instruction blocks — plain
constants the workbench prompt builder composes.

Part 17 Phase E cleanup: the skills-catalogue cache path
(``get_skills_segments`` / ``_build_skills_segments``) was dead code — zero
callers, superseded by the Tier-1/Tier-2 prompt caches (skill mutations bust
those via ``clear_skill_prompt_caches``). ``clear()`` remains as the
compatibility bust door for ``skill_service`` and the test fixtures.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()

CLARIFY_BLOCK = (
    '<clarify_policy>\n'
    'Clarifying questions when uncertain.\n'
    "When you are genuinely uncertain about the user's intent, requirements, or a decision "
    'that would change your approach, DO NOT guess or invent requirements. Instead, call the '
    '`submit_clarify` tool with a concise `question` (1-2 sentences) and up to 5 short `choices` '
    '(options the user can pick from). You may also pass a `questions` array to ask several '
    'related questions at once. Set `multiSelect: true` on a question when the user should be '
    'able to pick multiple options. The UI presents your choices as numbered options and adds its own '
    "free-text input for anything not covered, so do NOT include a 'something else' option yourself. "
    "Ask at most one round of clarifying questions unless the user's answer reveals new ambiguity. "
    'This applies in every guard mode, including plan mode.\n'
    '</clarify_policy>'
)

BULK_BLOCK = (
    '<bulk_tools>\n'
    'Bulk tools (prefer over N single calls).\n'
    'When the same operation applies to many items, one bulk call beats repeating the '
    'single tool — via the meta `bulk` tool (operation + matching array field) or the '
    'named [bulk]-tagged tools listed in <tools>. Cap is 40 items per call. Confirm with '
    'the user before bulk deletes/writes; bulk keeps the caution level of its primary '
    'bucket — it is a tag, not a downgrade.\n'
    '</bulk_tools>'
)

WEB_BLOCK = (
    '<web_research>\n'
    'Public web research (cite then fetch).\n'
    'web_search returns ranked titles/snippets only — it does not download bodies; '
    'web_fetch (or web_fetch_many) the few URLs you need in depth, not every search hit. '
    'Use browser_* only when the page needs real interaction (forms, JS apps).\n'
    '</web_research>'
)

MEMORY_BLOCK = (
    '<memory_policy>\n'
    'Long-term memory (the `remember` tool).\n'
    'Save only what should outlive this session and cannot be re-derived from the repo or the chat:\n'
    '- User-stated preferences, decisions, and constraints (category "user" / "project").\n'
    '- Feedback on how you should work (category "feedback").\n'
    '- Pointers to external resources (category "reference").\n'
    '- Durable lessons from your own work (category "project" / "reference"): after diagnosing '
    'and fixing a real problem, save the root cause, the fix, and where it lives (file:line).\n'
    'Shape: make the `fact` a description-first one-liner (scannable in an index); put depth in '
    '`details`; cross-reference related facts as [[key]] inside details.\n'
    'Do NOT save task steps, code structure, or anything git / the codebase already records.\n'
    "Update, don't duplicate: `list_facts` shows current keys — revise an existing fact under the "
    'same key instead of saving a twin; `forget` deletes one that is wrong or outdated.\n'
    'Correct yourself too: when a stored memory proves wrong, update the SAME key and say what '
    'changed — stale memory is worse than none. If the user corrects you, save it as category '
    '"feedback" under a stable key like `feedback:<short-topic>`.\n'
    'Sensitive topics (health specifics, ID numbers, minors, beliefs) are refused unless the user '
    'enabled sensitive memory — do not retry a refused save.\n'
    '</memory_policy>'
)

# One-shot end-of-turn nudge (2026-08-29): queued on the session when a
# substantial turn saved no memory; consumed into the NEXT turn's tail
# injection (never the system prompt — cache-safe). See
# workbench.queue_memory_habit_nudge / workbench.memory_nudge_block.
MEMORY_NUDGE_BLOCK = (
    '<memory_nudge>\n'
    'The previous turn did real work but saved no memory. If it produced durable knowledge '
    '(root cause + fix location, a user directive, a project constraint, a correction to a stored '
    'memory), save it now with `remember` — stable key, description-first one-liner, depth in '
    '`details`. Skip if nothing here will matter beyond this session.\n'
    '</memory_nudge>'
)


def clear() -> None:
    """Compatibility bust door — kept for ``skill_service`` and the test
    fixtures. The skills-segment cache itself was dead code (Phase E
    cleanup); real prompt busting happens in
    ``workbench.clear_skill_prompt_caches`` (Tier-1/2 caches)."""
    with _lock:
        pass


def stats() -> dict[str, object]:
    """Cache stats (Phase E: the skills segment cache is gone — Tier-1/2
    ``prompt_cache.stats()`` is the live instrument now)."""
    with _lock:
        return {
            'enabled': True,
            'skills_cached': False,
            'hits': 0,
            'misses': 0,
            'skills_ttl_s': 0,
        }
