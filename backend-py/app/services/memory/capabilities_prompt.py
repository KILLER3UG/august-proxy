"""Format organized tool buckets and skill catalogues for the system prompt.

Tool buckets are prompt taxonomy labels (not new API tools). ``tool_other`` is
fail-closed: unclassified tools inherit destructive-level caution in the prompt
until they are given an explicit primary bucket.

``tool_bulk`` is a cross-cutting *tag*, not a competing bucket — bulk tools keep
the caution level of their primary bucket (read / write / destructive / …).
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from app.json_narrowing import as_str

# Primary buckets (exactly one per tool). Order matters for prompt rendering.
BUCKET_ORDER: tuple[str, ...] = (
    'tool_read',
    'tool_write',
    'tool_destructive',
    'tool_shell',
    'tool_agent',
    'tool_skill',
    'tool_bridge',
    'tool_other',
)

BUCKET_BLURBS: dict[str, str] = {
    'tool_read': 'safe / non-mutating — investigate freely',
    'tool_write': 'create / update — not delete',
    'tool_destructive': 'delete / kill / irreversible — confirm when unsure',
    'tool_shell': 'command execution — gated in plan mode',
    'tool_agent': 'orchestration / background agents',
    'tool_skill': 'knowledge load / author',
    'tool_bridge': 'discover or inspect tool schemas',
    'tool_other': (
        'unclassified — treat with tool_destructive-level caution '
        '(confirm when unsure) until explicitly reclassified'
    ),
}

# Explicit primary classification. New tools must be added here (or they land in
# tool_other with fail-closed caution). The registry invariant test enforces this.
_TOOL_READ: frozenset[str] = frozenset(
    {
        'brain_query',
        'browser_get_content',
        'browser_open',
        'browser_screenshot',
        'browser_wait',
        'context_read',
        'describe_environment',
        'desktop_list_windows',
        'desktop_mouse_position',
        'desktop_screen_size',
        'desktop_screenshot',
        'diagnose_proxy',
        'fact_search',
        'get_fallback',
        'list_aliases',
        'list_directory',
        'memory_search',
        'read_blackboard',
        'read_file',
        'read_files',
        'search_files',
        'web_fetch',
        'web_fetch_many',
        'web_search',
    }
)

_TOOL_WRITE: frozenset[str] = frozenset(
    {
        'browser_click',
        'browser_evaluate',
        'browser_scroll',
        'browser_select',
        'browser_type',
        'bulk',  # nested operation decides caution; see bulk-tag note in prompt
        'configure_fallback',
        'create_alias',
        'desktop_click',
        'desktop_open_url',
        'desktop_press_key',
        'desktop_type',
        'rename_session',
        'rename_sessions',
        'setup_provider',
        'update_alias',
        'update_heuristics',
        'update_state',
        'write_blackboard',
        'write_file',
        'write_files',
        'write_scratchpad',
    }
)

_TOOL_DESTRUCTIVE: frozenset[str] = frozenset(
    {
        'clear_blackboard',
        'delete_agent',
        'delete_alias',
        'delete_folder',
        'delete_session',
        'delete_sessions',
        'kill_daemon',
        'kill_daemons',
    }
)

_TOOL_SHELL: frozenset[str] = frozenset({'run_command'})

_TOOL_AGENT: frozenset[str] = frozenset(
    {
        'create_agent',
        'list_agents',
        'list_daemons',
        'spawn_daemon',
        'spawn_subagent',
        'update_agent',
    }
)

_TOOL_SKILL: frozenset[str] = frozenset(
    {
        'list_skills',
        'load_skill',
        'load_skills',
        'skill_manage',
    }
)

_TOOL_BRIDGE: frozenset[str] = frozenset(
    {
        'tool_call',
        'tool_describe',
        'tool_search',
    }
)

# Cross-cutting tag — NOT a primary bucket (locked decision #5).
_BULK_TAGGED: frozenset[str] = frozenset(
    {
        'bulk',
        'delete_sessions',
        'kill_daemons',
        'load_skills',
        'read_files',
        'rename_sessions',
        'web_fetch_many',
        'write_files',
    }
)

_BUCKET_SETS: dict[str, frozenset[str]] = {
    'tool_read': _TOOL_READ,
    'tool_write': _TOOL_WRITE,
    'tool_destructive': _TOOL_DESTRUCTIVE,
    'tool_shell': _TOOL_SHELL,
    'tool_agent': _TOOL_AGENT,
    'tool_skill': _TOOL_SKILL,
    'tool_bridge': _TOOL_BRIDGE,
}

_EVOLVING_CREATED_BY: frozenset[str] = frozenset({'agent', 'auto-gen'})


def classify_tool(name: str) -> str:
    """Return the primary bucket for ``name`` (defaults to fail-closed ``tool_other``)."""
    n = (name or '').strip()
    if not n:
        return 'tool_other'
    for bucket, names in _BUCKET_SETS.items():
        if n in names:
            return bucket
    return 'tool_other'


def is_bulk_tagged(name: str) -> bool:
    return (name or '').strip() in _BULK_TAGGED


def unclassified_tools(tool_names: Iterable[str]) -> list[str]:
    """Return names that would fall into ``tool_other`` (should be empty in CI)."""
    return sorted({n for n in tool_names if n and classify_tool(n) == 'tool_other'})


def group_tools_by_bucket(
    tool_names: Iterable[str] | None = None,
) -> dict[str, list[str]]:
    """Group tool names by primary bucket. Empty buckets omitted except when filtering."""
    names = list(tool_names) if tool_names is not None else []
    if tool_names is None:
        try:
            from app.services.tool_registry import listRaw

            names = [as_str(t.get('name'), '') for t in listRaw()]
        except Exception:
            names = []
    grouped: dict[str, list[str]] = defaultdict(list)
    seen: set[str] = set()
    for raw in names:
        n = as_str(raw, '').strip()
        if not n or n in seen:
            continue
        seen.add(n)
        grouped[classify_tool(n)].append(n)
    for bucket in grouped:
        grouped[bucket].sort()
    return dict(grouped)


def format_tools_by_bucket(
    tool_names: Iterable[str] | None = None,
    *,
    include_empty: bool = False,
) -> str:
    """Render the ``<tools>`` body (bucket index + bulk-tag note)."""
    grouped = group_tools_by_bucket(tool_names)
    lines: list[str] = [
        'Tools are callable actions. Full schemas are provided separately in the tools array.',
        'Use this index to pick the right tool. Prefer tool_read for investigation;',
        'use tool_destructive only when the user intent requires irreversible change.',
        '',
        'Bulk note: tools tagged [bulk] (read_files, write_files, delete_sessions, kill_daemons,',
        'load_skills, rename_sessions, web_fetch_many, and the meta `bulk` tool) keep the caution',
        'level of their *primary* bucket below — tool_bulk is a tag layered on top, not an',
        'alternate classification that overrides destructive-confirmation guidance.',
        '',
    ]
    for bucket in BUCKET_ORDER:
        names = grouped.get(bucket, [])
        if not names and not include_empty and bucket != 'tool_other':
            continue
        if not names and bucket == 'tool_other' and not include_empty:
            continue
        blurb = BUCKET_BLURBS[bucket]
        lines.append(f'{bucket} ({blurb}):')
        if not names:
            lines.append('- (none)')
        else:
            # Chunk for readability
            tagged = [f'{n}[bulk]' if is_bulk_tagged(n) else n for n in names]
            for i in range(0, len(tagged), 6):
                chunk = ', '.join(tagged[i : i + 6])
                lines.append(f'- {chunk}')
        if bucket == 'tool_skill':
            lines.append(
                '  Note: load_skill(name) returns full instructions for bundled OR evolving skills.'
            )
        if bucket == 'tool_other' and names:
            lines.append(
                '  Caution: unclassified tools — confirm with the user before calling when unsure.'
            )
        lines.append('')
    return '\n'.join(lines).rstrip()


def format_skills_by_category(
    catalogue: list[dict[str, object]] | None = None,
) -> str:
    """Render the ``<skills>`` body grouped by category with [evolving] markers."""
    if catalogue is None:
        try:
            from app.services import skill_service

            catalogue = skill_service.catalogue()
        except Exception:
            catalogue = []
    lines: list[str] = [
        'Skills are on-demand capability extensions (knowledge, not actions).',
        'To use: call load_skill(name), then follow the returned body. For many: load_skills.',
        'This catalogue includes:',
        '  (1) Bundled skills shipped with August',
        '  (2) Evolving skills created through chat (background review / approved genesis)',
        '      — tagged [evolving] below. Both use the same load_skill tool.',
        '',
    ]
    if not catalogue:
        lines.append('(no skills discovered)')
        return '\n'.join(lines)

    by_cat: dict[str, list[dict[str, object]]] = defaultdict(list)
    for s in catalogue:
        cat = as_str(s.get('category'), 'uncategorized') or 'uncategorized'
        by_cat[cat].append(s)

    for cat in sorted(by_cat.keys()):
        lines.append(f'### {cat}')
        for s in sorted(by_cat[cat], key=lambda x: as_str(x.get('name'), '')):
            name = as_str(s.get('name'), '')
            if not name:
                continue
            desc = as_str(s.get('description'), '')
            trigger = as_str(s.get('trigger'), '')
            created = as_str(s.get('created_by'), '')
            evolving = ' [evolving]' if created in _EVOLVING_CREATED_BY else ''
            entry = f'- {name}{evolving}: {desc}' if desc else f'- {name}{evolving}'
            if trigger:
                entry += f' (trigger: {trigger})'
            lines.append(entry)
        lines.append('')
    return '\n'.join(lines).rstrip()


def format_agents_block() -> str:
    return '\n'.join(
        [
            '- Main agent: may call spawn_subagent(goal, agentId?, context?, background?)',
            '  or spawn_subagents({workItems:[...]}) to launch several in parallel.',
            '- Prefer multiple spawn_subagent calls in one turn (or one spawn_subagents call)',
            '  when investigating independent areas; set background=true (default for',
            '  spawn_subagents) so each completion is delivered to you as it finishes.',
            '- Subagents: complete the assigned goal; do NOT spawn further subagents.',
            '- Bound agent (if any): see <runtime_context>.',
            '- Any agent/subagent with load_skill permission may load ANY skill in <skills>',
            '  (bundled + evolving).',
        ]
    )


def build_capabilities_block(
    tool_names: Iterable[str] | None = None,
    catalogue: list[dict[str, object]] | None = None,
    *,
    include_skills: bool = True,
) -> str:
    """Full ``<capabilities>`` XML block for main or subagent prompts."""
    parts = [
        '<capabilities>',
        '<tools>',
        format_tools_by_bucket(tool_names),
        '</tools>',
    ]
    if include_skills:
        parts.extend(['', '<skills>', format_skills_by_category(catalogue), '</skills>'])
    else:
        parts.extend(
            [
                '',
                '<skills>',
                'Skills are unavailable for this agent (no load_skill permission).',
                '</skills>',
            ]
        )
    parts.extend(['', '<agents>', format_agents_block(), '</agents>', '</capabilities>'])
    return '\n'.join(parts)


def skills_tools_allowed(allowed_tool_names: Iterable[str]) -> bool:
    allowed = set(allowed_tool_names)
    return bool(allowed & {'load_skill', 'load_skills', 'list_skills'})
