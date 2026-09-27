"""Per-model tool surface: capability profiles, caps and MCP tail (P1#11 split).

Moved from workbench.py: the guard-mode normalizer, the transcript
tool-result cap, the per-model capability profile (full / reduced / bare /
text) with its TTL memo, the tool-result cap resolver, the tool-definition
name extractor, and the real MCP-server tool tails in both wire formats.

Two things deliberately did NOT move, even though only the tool surface
reads them: the fallback window ``DEFAULT_CONTEXT_WINDOW`` and
``_resolveModelContextWindow``. The first is the single ``128000`` in
workbench.py and tests/test_compaction_threshold_authority.py scans THIS
file's source text for it; the second is monkeypatched ON the workbench
module by tests/test_part26_wave2.py and tests/test_workbench_tool_loop.py.
For the same monkeypatch reason the two BUILDER functions
(``toolDefinitions`` / ``openaiToolDefinitions``) stay in workbench.py too
and call into this module for everything else. Every name here is
re-exported under its original name.

One-way import rule: nothing under loop/ imports workbench.py.
"""

from __future__ import annotations

import logging

from app.json_narrowing import as_dict, as_int, as_str
from app.services.workbench.sessions import WorkbenchSession

logger = logging.getLogger('workbench')

# Cap tool results stored in the transcript (SSE already truncates separately).
MAX_TOOL_RESULT_CHARS = 64 * 1024


def normalizeGuardMode(mode: str) -> str:
    """Normalize guard mode to one of: plan, ask, edit, full."""
    lower = mode.strip().lower().replace('_', '-').replace(' ', '-')
    aliases = {
        'plan': 'plan',
        'plan-only': 'plan',
        'plan-mode': 'plan',
        'ask': 'ask',
        'ask-before': 'ask',
        'ask-before-changes': 'ask',
        'edit': 'edit',
        'edit-auto': 'edit',
        'edit-automatically': 'edit',
        'auto': 'edit',
        'full': 'full',
        'full-access': 'full',
        'make-changes': 'full',
    }
    return aliases.get(lower, 'full')


# Per-model capability profiles (harness adaptation): a weak model gets a
# smaller tool surface and tighter result caps; a strong model keeps the full
# set. Configurable per model in Model settings.
_HEAVY_TOOL_PREFIXES = ('web_', 'browser', 'voice', 'notion', 'slack', 'discord', 'search', 'fetch')
_BARE_TOOL_ALLOW = frozenset(
    {
        # Names MUST match registered tools exactly (see
        # tests::test_bare_tool_allowlist_matches_registry). A stale name here
        # silently vanishes from the bare surface — e.g. the old 'edit_file' /
        # 'list_files' entries left weak models with no editor and no listing.
        'read_file',
        'read_files',
        'list_directory',
        'write_file',
        'edit_lines',
        'run_command',
        'update_state',
        'submit_todos',
        'update_todos',
        'write_scratchpad',
        'diagnose_proxy',
        # Memory CRUD has to arrive as a set. The `<memory_policy>` block tells
        # even the weakest model to "revise an existing fact under the same
        # key" and to "forget one that is wrong" — with only `remember`
        # offered, that instruction is unreachable and the store can only grow.
        # These three are the whole door: write, enumerate keys, retire.
        'remember',
        'list_facts',
        'forget',
    }
)


def _toolDefName(t: dict[str, object]) -> str:
    """Extract a tool definition's name (Anthropic or OpenAI shape)."""
    fn = as_dict(t.get('function'), {})
    return as_str(t.get('name') or fn.get('name'), '')


_capability_profile_cache: dict[tuple[str, str], tuple[float, dict[str, object]]] = {}
_CAPABILITY_PROFILE_TTL_S = 5.0


def _modelCapabilityProfile(session: WorkbenchSession) -> dict[str, object]:
    """Per-model tool profile from the provider config (never raises).

    Memoized on a 5s TTL per (model, provider): the uncached body walked
    getProvidersAsModels() — a full providers.json read + typed rebuild —
    and the tool-surface path hits it 2–3× per turn for the same pair.
    Provider edits apply within 5 seconds, which is fine for a tool
    surface; the config UI reloads the page anyway.
    """
    import time as _time

    modelId = as_str(getattr(session, 'model', '') or '')
    providerName = as_str(getattr(session, 'provider', '') or '')
    if not modelId:
        return {}
    cacheKey = (modelId, providerName)
    cached = _capability_profile_cache.get(cacheKey)
    now = _time.monotonic()
    if cached is not None and now - cached[0] < _CAPABILITY_PROFILE_TTL_S:
        return cached[1]
    profile: dict[str, object] = {}
    try:
        from app.services import config_service

        for p in config_service.getProvidersAsModels():
            if p.name != providerName and p.id != providerName:
                continue
            for m in p.models:
                if m.id == modelId:
                    profile = {
                        'tool_surface': m.tool_surface or 'full',
                        'max_tools': int(m.max_tools or 0),
                        'max_tool_result_chars': int(m.max_tool_result_chars or 0),
                    }
                    break
            if profile:
                break
    except Exception:
        pass
    _capability_profile_cache[cacheKey] = (now, profile)
    return profile


def _applyModelCapabilityProfile(
    session: WorkbenchSession, tools: list[dict[str, object]]
) -> list[dict[str, object]]:
    """Filter the tool surface by the session model's capability profile."""
    profile = _modelCapabilityProfile(session)
    surface = as_str(profile.get('tool_surface'), 'full')
    if surface == 'text':
        # Text tool protocol: no native tools are offered (models that
        # ignore `tools` must not be tempted); the model calls tools via
        # `[TOOLCALL] name|json` lines parsed by the turn loop.
        setattr(session, '_text_tool_protocol', True)
        return []
    if surface == 'bare':
        tools = [t for t in tools if _toolDefName(t) in _BARE_TOOL_ALLOW]
    elif surface == 'reduced':
        tools = [t for t in tools if not _toolDefName(t).startswith(_HEAVY_TOOL_PREFIXES)]
    maxTools = as_int(profile.get('max_tools'), 0)
    if maxTools > 0 and len(tools) > maxTools:
        tools = tools[:maxTools]
    return tools


def _finalize_session_tools(
    session: WorkbenchSession, tools: list[dict[str, object]]
) -> list[dict[str, object]]:
    tools = _applyModelCapabilityProfile(session, tools)
    from app.services.harness_mode import (
        filter_planner_tools,
        is_orchestrator_mode,
    )

    if is_orchestrator_mode(session):
        return filter_planner_tools(tools)
    return tools


def _toolResultCap(session: WorkbenchSession) -> int:
    """Per-model tool-result truncation cap (falls back to the harness default)."""
    profile = _modelCapabilityProfile(session)
    cap = as_int(profile.get('max_tool_result_chars'), 0)
    return cap if cap > 0 else MAX_TOOL_RESULT_CHARS


def _mcpToolDefinitionsAnthropic(seen: set[str]) -> list[dict[str, object]]:
    """Real MCP server tools in Anthropic format, deduped against ``seen``."""
    from app.adapters.proxy_tools import openai_to_anthropic_tool_definition
    from app.services.tools.mcp_client import getMcpToolDefinitionsSync

    out: list[dict[str, object]] = []
    for raw in getMcpToolDefinitionsSync():
        t = openai_to_anthropic_tool_definition(raw)
        name = as_str(t.get('name', ''))
        if name and name not in seen:
            seen.add(name)
            out.append(t)
    return out


def _mcpToolDefinitionsOpenai(seen: set[str]) -> list[dict[str, object]]:
    """Real MCP server tools in OpenAI format, deduped against ``seen``."""
    from app.services.tools.mcp_client import getMcpToolDefinitionsSync

    out: list[dict[str, object]] = []
    for raw in getMcpToolDefinitionsSync():
        fn = as_dict(raw.get('function', {})) if raw.get('type') == 'function' else {}
        name = as_str(fn.get('name', ''))
        if name and name not in seen:
            seen.add(name)
            out.append(raw)
    return out
