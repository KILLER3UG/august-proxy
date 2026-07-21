"""
Workbench chat engine — streaming chat loop, tool execution, and plan/approval.

Port of backend/services/workbench/workbench.js (3,675 lines).

Key subsystems:
- Session CRUD — see sessions.py (re-exported below for API stability)
- Streaming chat loop (Anthropic and OpenAI, streaming and non-streaming)
- Tool execution dispatch (15+ tool types)
- Plan/approval gate (plan mode, pending mutations, approval tokens)
- System prompt building (3-tier cache structure)
- Effort/thinking budget resolution (see effort.py; re-exported below)
- Provider/LLM call helpers (see providers.py; re-exported below)
- Goal system (stubbed)
- Subagent dispatch (stubbed)
"""

from __future__ import annotations
import asyncio
import json
import logging
import uuid
from typing import Callable, cast
from app.json_narrowing import as_str, as_dict, as_list, as_int, as_bool
from app.type_aliases import JsonValue
from app.services.workbench import sessions as _sessions_mod
from app.services.workbench.sessions import (
    WorkbenchSession,
    _sessions,
    _now,
    saveSessions,
    _emitSessionStatus,
    createWorkbenchSession,
    getWorkbenchSession,
)
from app.services.workbench.effort import (
    resolve_effective_effort,
    effort_to_thinking_budget,
    effort_to_prompt_instruction,
    effort_to_openai_reasoning_effort,
)
from app.services.workbench import providers as _providers_mod

logger = logging.getLogger('workbench')
# 0 = unlimited tool rounds by default. Safety nets: cancel signal, empty
# model responses, and brain-orchestrator maxWorkbenchToolLoops when set.
MAX_MANAGED_TOOL_ROUNDS = 0
# Legacy fallback only — auto-compact keys off the model's real contextWindow.
WORKBENCH_TOKEN_BUDGET = 2000000
# Auto-compact when estimated history reaches this fraction of the model window.
AUTO_COMPACT_RATIO = 0.80
# Cap tool results stored in the transcript (SSE already truncates separately).
MAX_TOOL_RESULT_CHARS = 64 * 1024

# Session API re-exports (explicit bindings so external importers keep working;
# ruff F401 would strip pure unused imports from the import list above).
_statusSubscribers = _sessions_mod._statusSubscribers
_sessionsPath = _sessions_mod._sessionsPath
_loadSessions = _sessions_mod._loadSessions
setWorkbenchSessionAgent = _sessions_mod.setWorkbenchSessionAgent
listWorkbenchSessions = _sessions_mod.listWorkbenchSessions
deleteWorkbenchSession = _sessions_mod.deleteWorkbenchSession
resetWorkbenchSession = _sessions_mod.resetWorkbenchSession
summarizeSession = _sessions_mod.summarizeSession
getWorkbenchSessionStatus = _sessions_mod.getWorkbenchSessionStatus
subscribeSessionStatus = _sessions_mod.subscribeSessionStatus
save_sessions = _sessions_mod.save_sessions
create_workbench_session = _sessions_mod.create_workbench_session
get_workbench_session = _sessions_mod.get_workbench_session
list_workbench_sessions = _sessions_mod.list_workbench_sessions
delete_workbench_session = _sessions_mod.delete_workbench_session
reset_workbench_session = _sessions_mod.reset_workbench_session
summarize_session = _sessions_mod.summarize_session
get_workbench_session_status = _sessions_mod.get_workbench_session_status
subscribe_session_status = _sessions_mod.subscribe_session_status
set_workbench_session_agent = _sessions_mod.set_workbench_session_agent
undo_last_turn = _sessions_mod.undo_last_turn
branch_workbench_session = _sessions_mod.branch_workbench_session
compact_workbench_session_now = _sessions_mod.compact_workbench_session_now
undoLastTurn = _sessions_mod.undoLastTurn
branchWorkbenchSession = _sessions_mod.branchWorkbenchSession
compactWorkbenchSessionNow = _sessions_mod.compactWorkbenchSessionNow

# Provider / LLM-call re-exports (tests monkeypatch these names on workbench)
resolve_workbench_provider = _providers_mod.resolve_workbench_provider
resolve_model = _providers_mod.resolve_model
resolve_chat_llm = _providers_mod.resolve_chat_llm
is_anthropic_provider = _providers_mod.is_anthropic_provider
is_openai_provider = _providers_mod.is_openai_provider
extract_text = _providers_mod.extract_text
extract_thinking = _providers_mod.extract_thinking
supports_thinking = _providers_mod.supports_thinking
call_anthropic_workbench = _providers_mod.call_anthropic_workbench
call_openai_workbench = _providers_mod.call_openai_workbench
background_task_model = _providers_mod.background_task_model
make_review_llm_client = _providers_mod.make_review_llm_client
_resolveWorkbenchProvider = _providers_mod.resolve_workbench_provider
_resolveModel = _providers_mod.resolve_model
_resolveChatLlm = _providers_mod.resolve_chat_llm
_isAnthropicProvider = _providers_mod.is_anthropic_provider
_isOpenaiProvider = _providers_mod.is_openai_provider
_extractText = _providers_mod.extract_text
_extractThinking = _providers_mod.extract_thinking
_supportsThinking = _providers_mod.supports_thinking
_callAnthropicWorkbench = _providers_mod.call_anthropic_workbench
_callOpenaiWorkbench = _providers_mod.call_openai_workbench
_backgroundTaskModel = _providers_mod.background_task_model
_makeReviewLlmClient = _providers_mod.make_review_llm_client


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


def isShellMutationTool(toolName: str, args: dict[str, object] | None = None) -> bool:
    """True when the tool is a shell/command execution (not a file edit)."""
    if not toolName:
        return False
    name = toolName.lower()
    shell = {
        'run_command',
        'bash',
        'bashtool',
        'shell',
        'exec',
        'execute',
        'terminal',
        'install',
        'uninstall',
        'pip_install',
        'npm_install',
        'pnpm_add',
    }
    if name in shell:
        return True
    if name == 'bulk':
        op = as_str((args or {}).get('operation')).lower().replace('-', '_')
        return op in {'run_command', 'bash', 'shell', 'exec'}
    return any(m in name for m in ('bash', 'shell', 'terminal', 'run_command'))


def isPlanModeBlocked(toolName: str, args: dict[str, object] | None = None) -> bool:
    """In plan mode, only DESTRUCTIVE tools are blocked.

    Everything else — read-only file tools, search, web, memory, agent,
    skill, MCP, and any other non-mutating tool — may run so the model can
    investigate freely. Destructive actions (writes, edits, deletes, shell
    commands, installs) require an approved plan; when the model attempts
    one it gets a tool result telling it to call `submit_plan` and ask the
    user for permission.
    """
    if not toolName:
        return False
    name = toolName.lower()
    destructive = {
        'write_file',
        'edit_file',
        'create_file',
        'str_replace',
        'str_replace_editor',
        'strreplaceeditttool',
        'apply_patch',
        'patch_file',
        'delete_file',
        'remove_file',
        'move_file',
        'rename_file',
        'mkdir',
        'makedirs',
        'run_command',
        'bash',
        'bashtool',
        'shell',
        'exec',
        'execute',
        'terminal',
        'install',
        'uninstall',
        'pip_install',
        'npm_install',
        'pnpm_add',
        'browser_click',
        'browser_type',
        'browser_select',
        'browser_evaluate',
        'create_agent',
        'update_agent',
        'delete_agent',
        'create_alias',
        'update_alias',
        'delete_alias',
        'configure_fallback',
    }
    if name in destructive:
        return True
    # Session/UI metadata renames are not workspace mutations — do not gate them.
    if name in {'rename_session', 'renamesession'}:
        return False
    # Meta bulk tool: gate by the nested operation, not the name "bulk".
    if name == 'bulk':
        op = as_str((args or {}).get('operation')).lower().replace('-', '_')
        mutating_ops = {
            'write_files',
            'write_file',
            'write',
            'delete_sessions',
            'delete_session',
            'rename_sessions',
            'rename_session',
            'kill_daemons',
            'kill_daemon',
        }
        return op in mutating_ops or any(
            m in op for m in ('write', 'delete', 'rename', 'kill')
        )
    if name in {'write_files', 'delete_sessions', 'rename_sessions', 'kill_daemons'}:
        return True
    destructiveMarkers = (
        'write',
        'edit',
        'delete',
        'remove',
        'install',
        'uninstall',
        'exec',
        'command',
        'bash',
        'shell',
        'patch',
        'rename',
        'kill_daemon',
    )
    return any((marker in name for marker in destructiveMarkers))


def buildSystemPrompt(
    session: WorkbenchSession,
    tools: list[dict[str, object]] | None = None,
) -> str:
    """Assemble the 3-tier XML system prompt for a workbench session (Phase 1).

    Uses the Phase 1 context_builder which emits the 3-tier structure:
      Tier 1: Identity & Constraints (static)
      Tier 2: Environment & Experience (semi-stable)
      Tier 3: Dynamic Runtime (volatile)

    Wires brain_orchestrator classification, workspace, VCS, memory stats,
    whats-new, and guard mode rules — achieving Node.js parity.

    ``tools``: optional pre-built Anthropic tool defs. Pass them when the
    caller already built the list so we do not call ``toolDefinitions`` again
    inside the prompt-build timing span.
    """
    from app.services.memory.context_builder import buildSystemPrompt as ctxBuild
    from app.services.memory_store import get_memory
    from app.services.workbench import prompt_segments_cache as _seg_cache

    memory = {}
    profile = get_memory('userProfile')
    if profile:
        memory['userProfile'] = profile
    context = get_memory('current_context')
    if context:
        memory['global_context'] = context
    projects = get_memory('active_projects')
    if projects:
        memory['active_projects'] = projects
    session._last_recalled_memories = None
    try:
        from app.services.memory.auto_memory import getRelevantMemories

        recentText = ''
        if session.messages:
            recent = session.messages[-6:] if len(session.messages) > 6 else session.messages
            recentText = ' '.join(
                (
                    str(m.get('content', '') or '')
                    for m in recent
                    if isinstance(m, dict) and m.get('role') in ('user', 'assistant')
                )
            )
        if recentText:
            prefetched = getRelevantMemories(recentText, limit=5)
            if prefetched:
                memory['autoMemories'] = cast('list[JsonValue]', prefetched)
                # Stashed for chatTurn() to emit as a `recalledMemories` SSE
                # event — visibility into what auto-memory recall actually used.
                session._last_recalled_memories = cast('list[dict[str, object]]', prefetched)
    except Exception:
        logger.debug('prompt: auto-memory prefetch failed', exc_info=True)
    try:
        from app.services.memory_store import _conn as brainConn

        conn = brainConn()
        heuristicsRows = conn.execute(
            'SELECT rule, source, category FROM learned_heuristics ORDER BY updated_at DESC'
        ).fetchall()
        if heuristicsRows:
            memory['learnedHeuristics'] = [dict(r) for r in heuristicsRows]
    except Exception:
        logger.debug('prompt: heuristics load failed', exc_info=True)
    coreFacts = get_memory('coreMemory')
    if coreFacts:
        memory['coreMemory'] = coreFacts
    agentContext = None
    if session.agentId:
        try:
            from app.services.tools.agent_registry import renderAgentContext

            agentContext = renderAgentContext(session.agentId)
        except Exception:
            logger.debug('prompt: agent context failed', exc_info=True)
    brainPolicy = None
    try:
        from app.services.memory.brain_orchestrator import extractTextFromMessages, classifyTask, policyForTask

        msgs = []
        if hasattr(session, 'messages') and session.messages:
            msgs = session.messages
        taskText = extractTextFromMessages(msgs)
        taskType = classifyTask(taskText)
        brainPolicy = policyForTask(taskType)
    except Exception:
        logger.debug('prompt: brain policy failed', exc_info=True)
    workspacePath = str(session.workspacePath) if hasattr(session, 'workspacePath') and session.workspacePath else ''
    vcsInfo = ''
    if workspacePath:
        try:
            import subprocess

            branch = subprocess.run(
                ['git', 'branch', '--show-current'], cwd=workspacePath, capture_output=True, text=True, timeout=5
            ).stdout.strip()
            status = subprocess.run(
                ['git', 'status', '--short'], cwd=workspacePath, capture_output=True, text=True, timeout=5
            ).stdout.strip()
            if branch:
                dirty = ' (dirty)' if status else ' (clean)'
                vcsInfo = f'{branch}{dirty}'
        except Exception:
            logger.debug('prompt: git vcs probe failed', exc_info=True)
    memoryStats = {}
    try:
        from app.services.memory_store import get_stats as memStats

        memoryStats = memStats()
    except Exception:
        logger.debug('prompt: memory stats failed', exc_info=True)
    whatsNew = ''
    if workspacePath:
        try:
            import subprocess

            log = subprocess.run(
                ['git', 'log', '--oneline', '--since=24 hours ago', '--max-count=10'],
                cwd=workspacePath,
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout.strip()
            if log:
                lines = log.split('\n')
                whatsNew = 'Recent git activity:\n' + '\n'.join((f'  - {line}' for line in lines))
        except Exception:
            logger.debug('prompt: git log failed', exc_info=True)
    skillsManifest, _skillsInner = _seg_cache.get_skills_segments()
    cognitiveBudget = None
    try:
        from app.services.workbench.token_budget import computeBudget

        provider = getattr(session, 'provider', None) or ''
        model = getattr(session, 'model', None) or ''
        providerName = provider.get('name', '') if isinstance(provider, dict) else str(provider)
        modelName = model.get('name', '') if isinstance(model, dict) else str(model)
        msgsForBudget = getattr(session, 'messages', []) or []
        cognitiveBudget = computeBudget(msgsForBudget, model=modelName or None, provider=providerName or None)
    except Exception:
        logger.debug('prompt: cognitive budget failed', exc_info=True)
    if tools is None:
        tools = toolDefinitions(session)
    tool_names: list[str] = []
    for t in tools or []:
        if isinstance(t, dict):
            n = as_str(t.get('name'), '')
            if not n:
                n = as_str(as_dict(t.get('function')).get('name'), '')
            if n:
                tool_names.append(n)
    capabilities_block = ''
    try:
        from app.services.memory.capabilities_prompt import build_capabilities_block

        capabilities_block = build_capabilities_block(tool_names or None)
    except Exception:
        logger.debug('prompt: capabilities block failed', exc_info=True)
    sessionDict = {
        # Ambient identity so tools like delete/rename/brain_query can target
        # "this chat" without a prior list call.
        'id': getattr(session, 'id', None) or '',
        'title': getattr(session, 'title', None) or '',
        'goal': session.goal,
        'plan': session.plan,
        'planApproved': session.planApproved,
        'guardMode': normalizeGuardMode(getattr(session, 'guardMode', None) or 'full'),
        'agentId': getattr(session, 'agentId', None) or '',
        'workspacePath': workspacePath,
        'vcs': vcsInfo,
        'brainPolicy': brainPolicy,
        'cognitiveBudget': cognitiveBudget,
        'memoryStats': memoryStats,
        'whatsNew': whatsNew,
        'skillsManifest': skillsManifest,
        'capabilitiesBlock': capabilities_block,
        'toolNames': tool_names,
        'executionState': getattr(session, '_execution_state', None),
        'workingMemory': getattr(session, '_working_memory', None),
        'subconsciousUpdates': _buildDaemonUpdates(getattr(session, 'id', '')),
        # Tool self-heal: structured failure from last tool exception (if any).
        'failureFeedback': getattr(session, '_failure_feedback', None),
    }
    for k in ('coreMemory', 'learnedHeuristics', 'autoMemories'):
        if k in memory:
            sessionDict[k] = memory[k]
    # Load workspace AUG.md into Tier 2 as soft context (Claude CLAUDE.md parity).
    augMdBody = ''
    if workspacePath:
        try:
            from app.services import aug_directive_service

            loaded = aug_directive_service.load(workspacePath)
            if loaded and loaded.get('body'):
                augMdBody = as_str(loaded.get('body', ''))
        except Exception:
            logger.debug('prompt: AUG.md load failed', exc_info=True)
    sessionDict['augMd'] = augMdBody
    sessionDict['todos'] = session.todos
    from app.services.workbench.prompt_cache import getCache

    promptCache = getCache()
    cacheKey = getattr(session, 'id', '') or ''
    cachedT12 = promptCache.get(cacheKey)
    base = ctxBuild(
        session=sessionDict,
        memory=cast('dict[str, object]', memory),
        tools=tools,
        agentContext=agentContext,
        cachedT12=cachedT12,
    )
    if cachedT12 is None:
        try:
            from app.services.memory.context_builder import buildTier1, buildTier2, wrapTag

            t1 = buildTier1(sessionDict)
            t2 = buildTier2(sessionDict)
            t12Parts = []
            # Cache the same wrapped form that buildSystemPrompt emits (no double-emit).
            if t1:
                t12Parts.append(wrapTag('tier1_identity', t1))
            if t2:
                t12Parts.append(wrapTag('tier2_experience', t2))
            if t12Parts:
                promptCache.set(cacheKey, '\n\n'.join(t12Parts))
        except Exception:
            logger.debug('prompt: T1/T2 cache write failed', exc_info=True)
    # Skills catalogue is inside Tier 1 <capabilities>; do not append a duplicate
    # markdown "## Available Skills" block.
    extraParts: list[str] = [_seg_cache.CLARIFY_BLOCK, _seg_cache.BULK_BLOCK]
    return base + '\n\n' + '\n\n'.join(extraParts)


def _resolveModelContextWindow(
    resolvedModel: str, resolvedProvider: dict[str, object] | None
) -> int:
    """Model context window for auto-compact (never the legacy 2M workbench budget)."""
    try:
        from app.services.model_service import _getContextWindow

        window = int(_getContextWindow(resolvedModel, resolvedProvider) or 0)
        if window > 0:
            return max(8192, window)
    except Exception:
        logger.debug('resolveModelContextWindow failed', exc_info=True)
    return 128000


def _shouldAutoCompact(attention_pressure: str, turns_since_compaction: int) -> bool:
    """Auto-compact at high (≥80%) or critical (≥90%) pressure after a short cooldown.

    Cooldown avoids re-compacting every turn once we are near the window.
    """
    return attention_pressure in ('high', 'critical') and turns_since_compaction >= 2


# Snake_case alias for tests / external callers.
_should_auto_compact = _shouldAutoCompact


def _buildDaemonUpdates(sessionId: str) -> str:
    """Build the <subconscious_updates> XML block from daemon results.

    v2: Preserves the [CRITICAL] prefix on daemon output so the model
    can detect critical alerts and pause to inform the user.
    """
    try:
        from app.services.daemon_manager import getManager

        manager = getManager()
        daemons = manager.list_daemons(sessionId)
        if not daemons:
            return ''
        lines: list[str] = ['<subconscious_updates>']
        for d in daemons:
            attrs = f'''name="{_xmlEscape(d['name'])}" status="{d['status']}"'''
            if d.get('triggered'):
                attrs += ' triggered="true"'
            output = as_str(d.get('output'), '')
            if d.get('error'):
                attrs += f''' error="{_xmlEscape(as_str(d.get('error')))}"'''
                lines.append(f'  <daemon {attrs} />')
            elif output:
                lines.append(f'  <daemon {attrs}>{_xmlEscape(output)}</daemon>')
            else:
                lines.append(f'  <daemon {attrs} />')
        lines.append('</subconscious_updates>')
        return '\n'.join(lines)
    except Exception:
        return ''


def _xmlEscape(s: str) -> str:
    """Minimal XML attribute/text escape."""
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


# camelCase wrappers for back-compat (tests / external callers)
def resolveEffectiveEffort(
    incoming: str | None, session: WorkbenchSession, modelEntry: dict[str, object] | None = None
) -> str:
    return resolve_effective_effort(incoming, session, modelEntry)


def effortToThinkingBudget(effort: str, modelMax: int, maxTokens: int | None = None) -> int:
    """``modelMax`` is the model's max output tokens (required)."""
    return effort_to_thinking_budget(effort, model_max=modelMax, max_tokens=maxTokens)


def effortToPromptInstruction(effort: str) -> str:
    return effort_to_prompt_instruction(effort)


def effortToOpenaiReasoningEffort(effort: str) -> str:
    return effort_to_openai_reasoning_effort(effort)


def toolDefinitions(session: WorkbenchSession) -> list[dict[str, object]]:
    """Return tool definitions in Anthropic format for a session.

    The tool registry stores definitions in OpenAI format
    (``{"type":"function","function":{...}}``). Anthropic's API expects a
    different shape (``{"name","description","input_schema"}``). We
    canonicalize every registered tool through
    ``sanitize_anthropic_tool_definition`` (a no-op for already-Anthropic
    entries, a converter for OpenAI entries) and dedupe by name.

    We deliberately do NOT append the proxy-passthrough ``mcp__workspace__*``
    / ``WebSearch`` / ``WebFetch`` managed tools here: those are only
    dispatchable inside the proxy passthrough adapter, not in the
    workbench (whose ``_execute_tool`` consults ``tool_registry`` only).
    The workbench registers its own ``web_search`` / ``web_fetch`` /
    ``run_command`` handlers, which cover the same surface and *are*
    dispatchable here. MCP server tools are added separately (see
    ``_mcp_tool_definitions_anthropic``).

    Phase 3: If progressive disclosure is active and the tool set exceeds
    the threshold, BM25 pre-loads the most relevant tools and defers the rest.

    The base registry→Anthropic conversion (+ MCP) is cached; progressive
    disclosure still runs per session messages.
    """
    from app.services.workbench import tool_defs_cache

    def _build_base() -> list[dict[str, object]]:
        from app.adapters.proxy_tools import sanitize_anthropic_tool_definition
        from app.services.tool_registry import listTools

        tools: list[dict[str, object]] = []
        seen: set[str] = set()
        for raw in listTools():
            t = sanitize_anthropic_tool_definition(raw)
            if not t:
                continue
            if t['name'] in seen:
                continue
            seen.add(as_str(t['name']))
            tools.append(t)
        tools.extend(_mcpToolDefinitionsAnthropic(seen))
        return tools

    tools = tool_defs_cache.get_or_build('anthropic', _build_base)
    try:
        from app.services.tools.model_tools import assembleToolDefs

        messages = getattr(session, 'messages', None) or []
        contextMsgs = list(messages) if isinstance(messages, list) else []
        result = assembleToolDefs(all_tool_defs=tools, context_messages=contextMsgs)
        if result.activated:
            session._tool_assembly = result
            tools = result.tool_defs
    except Exception:
        pass
    # System barrier: Full Access must not expose plan-gating tools.
    mode = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')
    if mode == 'full':
        blocked = {'submit_plan', 'submitPlan', 'approve_plan', 'reject_plan'}
        tools = [t for t in tools if as_str(t.get('name')) not in blocked]
    return tools


def openaiToolDefinitions(session: WorkbenchSession) -> list[dict[str, object]]:
    """Return tool definitions in OpenAI format for a session.

    Mirrors ``tool_definitions``: registry tools (which may be in mixed
    OpenAI/Anthropic format) are normalized to OpenAI format and deduped
    by name, then real MCP server tools are appended.

    Base conversion is cached by registry generation counter + MCP signature.
    """
    from app.services.workbench import tool_defs_cache

    def _build_base() -> list[dict[str, object]]:
        from app.adapters.proxy_tools import anthropic_to_openai_tool_definition
        from app.services.tool_registry import listTools

        tools: list[dict[str, object]] = []
        seen: set[str] = set()
        for raw in listTools():
            if as_str(raw.get('type')) == 'function' and isinstance(raw.get('function'), dict):
                name = as_str(as_dict(raw.get('function')).get('name', ''))
                if name and name not in seen:
                    seen.add(name)
                    tools.append(raw)
                continue
            t = anthropic_to_openai_tool_definition(raw)
            name = as_str(as_dict(t.get('function', {})).get('name', ''))
            if name and name not in seen:
                seen.add(name)
                tools.append(t)
        tools.extend(_mcpToolDefinitionsOpenai(seen))
        return tools

    tools = tool_defs_cache.get_or_build('openai', _build_base)
    mode = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')
    if mode == 'full':
        blocked = {'submit_plan', 'submitPlan', 'approve_plan', 'reject_plan'}

        def _tool_name(t: dict[str, object]) -> str:
            fn = as_dict(t.get('function'))
            return as_str(fn.get('name') or t.get('name'))

        tools = [t for t in tools if _tool_name(t) not in blocked]
    return tools


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


def _formatQueuedMessagesAsUserTurn(entries: list[dict[str, object]]) -> dict[str, object]:
    """Build a single user-role message that wraps one or more queued/steer entries.

    Steers (``kind=steer``) are mid-run course corrections and take priority
    in the preamble. Subagent completions (``kind=subagent``) are next so the
    model sees per-subagent results as they settle. Ordinary queue entries
    are follow-ups for later.
    """
    if not entries:
        return {'role': 'user', 'content': ''}

    def _kind_rank(e: dict[str, object]) -> int:
        k = as_str(e.get('kind'), 'queue')
        if k == 'steer':
            return 0
        if k == 'subagent':
            return 1
        return 2

    ordered = sorted(entries, key=_kind_rank)
    steers = [e for e in ordered if as_str(e.get('kind'), 'queue') == 'steer']
    subagents = [e for e in ordered if as_str(e.get('kind'), 'queue') == 'subagent']
    queues = [e for e in ordered if as_str(e.get('kind'), 'queue') not in ('steer', 'subagent')]
    parts: list[str] = []
    if steers:
        parts.append(
            '[STEER — The user is redirecting your current work mid-run. '
            'These instructions apply immediately after your current tool step. '
            'Adjust your plan, cancel outdated steps if needed, and prioritize this guidance. '
            'Do not ignore it.]'
        )
        parts.append('')
        for entry in steers:
            text = as_str(entry.get('text'), '')
            queuedAt = entry.get('queuedAt') or ''
            attr = f' timestamp="{queuedAt}"' if queuedAt else ''
            parts.append(f'<steer{attr}>')
            parts.append(text)
            parts.append('</steer>')
            parts.append('')
    if subagents:
        parts.append(
            '[SUBAGENT RESULTS — One or more background subagents finished. '
            'Each block below is that subagent\'s completion (taskId + output). '
            'Incorporate useful findings; do not re-launch the same work unless needed.]'
        )
        parts.append('')
        for entry in subagents:
            text = as_str(entry.get('text'), '')
            parts.append(text)
            parts.append('')
    if queues:
        parts.append(
            '[The following message(s) were queued by the user while you were responding. '
            'They did NOT interrupt your current work — they were added as follow-up(s). '
            'Consider whether each one changes your approach, supersedes the original request, '
            'or should simply be acknowledged for later.]'
        )
        parts.append('')
        for entry in queues:
            queuedAt = entry.get('queuedAt') or ''
            text = as_str(entry.get('text'), '')
            attachmentCount = len(as_list(entry.get('attachments'), []))
            attrParts = []
            if queuedAt:
                attrParts.append(f'timestamp="{queuedAt}"')
            if attachmentCount:
                attrParts.append(f'attachments="{attachmentCount}"')
            attrStr = ' ' + ' '.join(attrParts) if attrParts else ''
            parts.append(f'<queued_message{attrStr}>')
            parts.append(text)
            parts.append('</queued_message>')
            parts.append('')
    return {'role': 'user', 'content': '\n'.join(parts).strip()}


def enqueueUserMessage(
    sessionId: str,
    text: str,
    attachments: list[dict[str, object]] | None = None,
    *,
    kind: str = 'queue',
) -> dict[str, object] | None:
    """Append a user message to the session's pending queue.

    ``kind``:
      - ``queue`` — follow-up for the next loop boundary (default)
      - ``steer`` — mid-run course correction; formatted with higher priority
      - ``subagent`` — background subagent completion; delivered per-agent as it settles

    Returns the queued entry on success, or None if the session does not
    exist. Emits a ``user_message_queued`` SSE event so open tabs can
    update their local view in real time.
    """
    session = _sessions.get(sessionId)
    if not session:
        return None
    if not hasattr(session, 'queuedUserMessages') or session.queuedUserMessages is None:
        session.queuedUserMessages = []
    kind_n = (kind or 'queue').strip().lower()
    if kind_n not in ('queue', 'steer', 'subagent'):
        kind_n = 'queue'
    entry: dict[str, object] = {
        'id': f'qm_{uuid.uuid4().hex[:12]}',
        'text': text,
        'attachments': list(attachments or []),
        'queuedAt': _now(),
        'kind': kind_n,
    }
    # Steers and subagent completions jump to the front so they apply first
    if kind_n in ('steer', 'subagent'):
        session.queuedUserMessages.insert(0, entry)
    else:
        session.queuedUserMessages.append(entry)
    session.updatedAt = _now()
    saveSessions()
    try:
        from app.services import event_log

        event_log.event_log.append(
            sessionId,
            'user_message_queued',
            {
                'sessionId': sessionId,
                'messageId': entry['id'],
                'text': text,
                'queuedAt': entry['queuedAt'],
                'kind': kind_n,
            },
        )
    except Exception:
        pass
    return entry


def enqueueSteerMessage(
    sessionId: str, text: str, attachments: list[dict[str, object]] | None = None
) -> dict[str, object] | None:
    """Convenience: enqueue a mid-run steer (course correction)."""
    return enqueueUserMessage(sessionId, text, attachments, kind='steer')


def dequeueUserMessage(sessionId: str, messageId: str) -> bool:
    """Remove a single queued message by id. Emits ``user_message_dequeued``."""
    session = _sessions.get(sessionId)
    if not session:
        return False
    entries = getattr(session, 'queuedUserMessages', None) or []
    removed: dict[str, object] | None = None
    kept: list[dict[str, object]] = []
    for entry in entries:
        if entry.get('id') == messageId and removed is None:
            removed = entry
        else:
            kept.append(entry)
    if removed is None:
        return False
    session.queuedUserMessages = kept
    session.updatedAt = _now()
    saveSessions()
    try:
        from app.services import event_log

        event_log.event_log.append(sessionId, 'user_message_dequeued', {'sessionId': sessionId, 'messageId': messageId})
    except Exception:
        pass
    return True


def listQueuedMessages(sessionId: str) -> list[dict[str, object]]:
    """Return the current queued messages for a session."""
    session = _sessions.get(sessionId)
    if not session:
        return []
    return list(getattr(session, 'queuedUserMessages', None) or [])


def reorderQueuedMessages(sessionId: str, orderedIds: list[str]) -> list[dict[str, object]] | None:
    """Reorder the session queue to match ``orderedIds`` (unknown ids ignored).

    Ids not present in ``orderedIds`` are appended in their previous relative order.
    Returns the new list, or None if the session is missing.
    """
    session = _sessions.get(sessionId)
    if not session:
        return None
    entries = list(getattr(session, 'queuedUserMessages', None) or [])
    if not entries:
        return []
    by_id = {str(e.get('id')): e for e in entries if e.get('id')}
    seen: set[str] = set()
    reordered: list[dict[str, object]] = []
    for mid in orderedIds or []:
        key = str(mid)
        if key in by_id and key not in seen:
            reordered.append(by_id[key])
            seen.add(key)
    for e in entries:
        key = str(e.get('id') or '')
        if key and key not in seen:
            reordered.append(e)
            seen.add(key)
    session.queuedUserMessages = reordered
    session.updatedAt = _now()
    saveSessions()
    try:
        from app.services import event_log

        event_log.event_log.append(
            sessionId,
            'user_message_queue_reordered',
            {
                'sessionId': sessionId,
                'order': [str(e.get('id')) for e in reordered],
            },
        )
    except Exception:
        pass
    return reordered


def updateQueuedMessage(
    sessionId: str, messageId: str, text: str | None = None
) -> dict[str, object] | None:
    """Edit the text of a queued message before delivery. Returns the entry or None."""
    session = _sessions.get(sessionId)
    if not session:
        return None
    entries = list(getattr(session, 'queuedUserMessages', None) or [])
    for entry in entries:
        if entry.get('id') == messageId:
            if text is not None:
                entry['text'] = text
            session.queuedUserMessages = entries
            session.updatedAt = _now()
            saveSessions()
            try:
                from app.services import event_log

                event_log.event_log.append(
                    sessionId,
                    'user_message_queue_updated',
                    {
                        'sessionId': sessionId,
                        'messageId': messageId,
                        'text': entry.get('text', ''),
                    },
                )
            except Exception:
                pass
            return entry
    return None


def clearQueuedMessages(sessionId: str) -> int:
    """Remove all queued messages for a session. Returns count removed."""
    session = _sessions.get(sessionId)
    if not session:
        return 0
    entries = list(getattr(session, 'queuedUserMessages', None) or [])
    if not entries:
        return 0
    n = len(entries)
    session.queuedUserMessages = []
    session.updatedAt = _now()
    saveSessions()
    try:
        from app.services import event_log

        for entry in entries:
            event_log.event_log.append(
                sessionId,
                'user_message_dequeued',
                {'sessionId': sessionId, 'messageId': entry.get('id')},
            )
        event_log.event_log.append(
            sessionId,
            'user_message_queue_cleared',
            {'sessionId': sessionId, 'count': n},
        )
    except Exception:
        pass
    return n


def drainQueuedMessages(
    sessionId: str, emit: Callable[[dict[str, object]], None] | None = None
) -> list[dict[str, object]]:
    """Pop all queued messages and return them in FIFO order.

    Also emits a ``user_message_injected`` event per entry so the
    frontend can render each queued message as an inline user bubble
    in the conversation thread.
    """
    session = _sessions.get(sessionId)
    if not session:
        return []
    entries = list(getattr(session, 'queuedUserMessages', None) or [])
    if not entries:
        return []
    session.queuedUserMessages = []
    session.updatedAt = _now()
    saveSessions()
    if emit is not None:
        try:
            from app.services import event_log

            for entry in entries:
                event_log.event_log.append(
                    sessionId,
                    'userMessageInjected',
                    {
                        'sessionId': sessionId,
                        'messageId': entry.get('id', ''),
                        'text': entry.get('text', ''),
                        'queuedAt': entry.get('queuedAt', ''),
                    },
                )
        except Exception:
            pass
    return entries


async def sendWorkbenchMessageStream(
    sessionId: str,
    message: str,
    provider: str = '',
    agentId: str = '',
    effort: str = '',
    model: str = '',
    modelProvider: str = '',
    guardMode: str = '',
    thinking_enabled: bool = True,
    handoff_summary: str = '',
    emit: Callable[[dict[str, object]], None] | None = None,
    signal: asyncio.Event | None = None,
) -> None:
    """The primary streaming entry point for workbench chat.

    This is the main chat loop that:
    1. Gets or creates the session
    2. Appends the user message
    3. Resolves provider/model
    4. Calls the model's streaming endpoint
    5. Handles tool calls in a loop
    6. Emits events for the SSE stream
    """
    # Optional perf span/TTFT tracing (AUGUST_PERF_TIMING=1 or tests force a current trace).
    from app.lib.perf_timing import clear_current, current_trace, start_trace

    _owned_trace = False
    trace = current_trace()
    if trace is None:
        trace = start_trace('workbench_stream', sessionId=sessionId or '')
        _owned_trace = True
    from app.lib.batched_emit import BatchedEmit

    _batched: BatchedEmit | None = None
    if emit is not None:
        _batched = BatchedEmit(
            emit,
            max_chars=256,
            on_first_content=trace.mark_ttft,
        )
        emit = _batched  # type: ignore[assignment]

    try:
        await _sendWorkbenchMessageStreamImpl(
            sessionId=sessionId,
            message=message,
            provider=provider,
            agentId=agentId,
            effort=effort,
            model=model,
            modelProvider=modelProvider,
            guardMode=guardMode,
            thinking_enabled=thinking_enabled,
            handoff_summary=handoff_summary,
            emit=emit,
            signal=signal,
            trace=trace,
        )
    finally:
        if _batched is not None:
            _batched.flush()
        if _owned_trace:
            trace.finish()
            clear_current()


async def _sendWorkbenchMessageStreamImpl(
    sessionId: str,
    message: str,
    provider: str = '',
    agentId: str = '',
    effort: str = '',
    model: str = '',
    modelProvider: str = '',
    guardMode: str = '',
    thinking_enabled: bool = True,
    handoff_summary: str = '',
    emit: Callable[[dict[str, object]], None] | None = None,
    signal: asyncio.Event | None = None,
    trace: object | None = None,
) -> None:
    """Implementation of the streaming chat loop (optional timing via ``trace``)."""
    from app.lib.perf_timing import PerfTrace

    _trace = cast(PerfTrace, trace) if trace is not None else PerfTrace('noop')

    session = getWorkbenchSession(sessionId)
    if not session:
        session = createWorkbenchSession(provider=provider, agentId=agentId, guardMode=guardMode or 'full')
        sessionId = session.id
    if provider:
        session.provider = provider
    if agentId:
        session.agentId = agentId
    if guardMode:
        session.guardMode = normalizeGuardMode(guardMode)
    session.status = 'streaming'
    session.updatedAt = _now()
    _emitSessionStatus(sessionId)
    session.messages.append({'role': 'user', 'content': message})
    session.messageCount += 1
    # Title is generated after the first assistant reply (see schedule_auto_title
    # below) — do not stamp the raw first user message into the sidebar.
    effectiveEffort = resolveEffectiveEffort(effort or as_str(session.metadata.get('effort', '')), session)
    # Persist so later turns / BTW inherit the composer effort selection.
    session.metadata['effort'] = effectiveEffort
    resolvedProvider, resolvedModel = _resolveChatLlm(
        model=model or '',
        model_provider=modelProvider or '',
        session_provider=session.provider or provider or '',
        session_model=session.model or '',
    )
    # Remember model/provider on the session so BTW and Live use the same ones.
    if resolvedModel:
        session.model = resolvedModel
    if resolvedProvider:
        pname = as_str(resolvedProvider.get('name') or resolvedProvider.get('id'))
        if pname:
            session.provider = pname
    if emit:
        emit({'type': 'started', 'sessionId': sessionId, 'model': resolvedModel})
    if not resolvedProvider:
        if emit:
            emit(
                {
                    'type': 'error',
                    'message': (
                        'No model provider is configured with an API key. '
                        'Open Settings → Model settings, add a provider, then select one of its models.'
                    ),
                }
            )
            emit({'type': 'done', 'sessionId': sessionId})
        session.status = 'idle'
        session.updatedAt = _now()
        try:
            saveSessions()
        except Exception:
            logger.exception('workbench save_sessions failed after missing provider')
        _emitSessionStatus(sessionId)
        return
    if resolvedProvider:
        from app.services import provider_credentials

        # Prefer key already on the resolved provider dict (custom store),
        # then credentials lookup by id, then by display name.
        apiKey = as_str(resolvedProvider.get('api_key') or resolvedProvider.get('apiKey'))
        if not apiKey:
            for key in (
                as_str(resolvedProvider.get('id')),
                as_str(resolvedProvider.get('name')),
            ):
                if not key:
                    continue
                creds = provider_credentials.resolve(key)
                apiKey = as_str((creds or {}).get('api_key')) if creds else ''
                if apiKey:
                    break
        if not apiKey:
            if emit:
                emit(
                    {
                        'type': 'error',
                        'message': (
                            f'API key not configured for {resolvedProvider.get("name", "unknown")}. '
                            'Open Settings → Model settings and paste a key for this provider.'
                        ),
                    }
                )
            session.status = 'idle'
            session.updatedAt = _now()
            try:
                saveSessions()
            except Exception:
                logger.exception('workbench save_sessions failed after missing API key')
            _emitSessionStatus(sessionId)
            if emit:
                emit({'type': 'done', 'sessionId': sessionId})
            return
    if session._failure_feedback_age is not None:
        session._failure_feedback_age += 1
        if session._failure_feedback_age >= 3:
            session._failure_feedback = None
            session._failure_feedback_age = None
    with _trace.span('prompt_build'):
        # Build tool defs once and pass into system prompt (no double conversion).
        tools = toolDefinitions(session)
        openaiTools = openaiToolDefinitions(session)
        systemText = buildSystemPrompt(session, tools=tools)
        if emit and session._last_recalled_memories:
            emit(
                {
                    'type': 'recalledMemories',
                    'items': [
                        {
                            'id': str(m.get('key') or ''),
                            'key': str(m.get('key') or ''),
                            'category': str(m.get('category') or 'auto'),
                            'snippet': str(m.get('description') or m.get('label') or '')[:200],
                        }
                        for m in session._last_recalled_memories
                        if isinstance(m, dict)
                    ],
                }
            )
        # Effort scales thinking depth for every provider (Anthropic budget /
        # OpenAI reasoning_effort / prompt hint for OpenAI-compatible APIs).
        if thinking_enabled:
            systemText = (
                f'{systemText}\n\n<effort>\n{effort_to_prompt_instruction(effectiveEffort)}\n</effort>'
            )
        else:
            systemText = (
                f'{systemText}\n\n<effort>\n'
                'Do not use extended reasoning or long chain-of-thought. '
                'Answer directly with minimal internal thinking.\n'
                '</effort>'
            )
        handoff = (handoff_summary or '').strip()
        if handoff:
            systemText = (
                f'{systemText}\n\n'
                '<model_handoff>\n'
                f'{handoff}\n'
                '</model_handoff>'
            )
    isAnthropic = _isAnthropicProvider(resolvedProvider)
    isOpenai = _isOpenaiProvider(resolvedProvider)

    def _isCancelled() -> bool:
        return signal is not None and signal.is_set()

    try:
        from app.services.memory.context_compressor import compressMessages, isFeatureEnabled
        from app.providers.clients.base import estimateTokens

        if isFeatureEnabled():
            contextWindow = _resolveModelContextWindow(resolvedModel, resolvedProvider)
            originalTokens = estimateTokens(session.messages)
            ratio = originalTokens / contextWindow if contextWindow else 0.0
            if ratio >= 0.9:
                attentionPressure = 'critical'
            elif ratio >= AUTO_COMPACT_RATIO:
                attentionPressure = 'high'
            elif ratio >= 0.5:
                attentionPressure = 'medium'
            else:
                attentionPressure = 'low'
            currentTurn = getattr(session, 'turn_count', 0)
            lastCompaction = getattr(session, '_last_compaction_turn', -100)
            turnsSinceCompaction = currentTurn - lastCompaction
            # Compress toward ~55% of the real window so the next turn has headroom.
            threshold = max(4096, int(contextWindow * 0.55))
            currentMessages = list(session.messages)
            if _shouldAutoCompact(attentionPressure, turnsSinceCompaction):
                compressed = compressMessages(currentMessages, threshold=threshold, head_count=4, tail_count=6)
                compressedTokens = estimateTokens(compressed)
                if compressedTokens < originalTokens:
                    compressedCount = len(currentMessages) - len(compressed)
                    currentMessages = compressed
                    # Persist so later turns / reload don't re-send the bloated history.
                    session.messages = list(compressed)
                    session.messageCount = len(session.messages)
                    session._last_compaction_turn = currentTurn
                    try:
                        saveSessions()
                    except Exception:
                        logger.exception('workbench save_sessions failed after auto-compact')
                    if emit:
                        emit(
                            {
                                'type': 'compaction',
                                'originalTokens': originalTokens,
                                'compressedTokens': compressedTokens,
                                'compressedCount': compressedCount,
                                'headCount': 4,
                                'tailCount': 6,
                                'threshold': threshold,
                                'contextWindow': contextWindow,
                                'underThreshold': False,
                            }
                        )
                    logger.info(
                        'workbench auto-compact session=%s tokens=%d→%d ratio=%.2f window=%d',
                        sessionId,
                        originalTokens,
                        compressedTokens,
                        ratio,
                        contextWindow,
                    )
        else:
            currentMessages = list(session.messages)
    except Exception:
        currentMessages = list(session.messages)
    totalInputTokens = 0
    totalOutputTokens = 0
    finalContextTokens = 0
    toolRound = 0
    while True:
        toolRound += 1
        if MAX_MANAGED_TOOL_ROUNDS > 0 and toolRound > MAX_MANAGED_TOOL_ROUNDS:
            msg = (
                f'Tool loop exceeded MAX_MANAGED_TOOL_ROUNDS ({MAX_MANAGED_TOOL_ROUNDS}); '
                'stopping to avoid unbounded cost.'
            )
            logger.warning('workbench %s', msg)
            if emit:
                emit({'type': 'error', 'message': msg})
            break
        if _isCancelled():
            break
        if toolRound > 1:
            queued = drainQueuedMessages(sessionId, emit=emit)
            if queued:
                logger.debug('workbench round %d: injecting %d queued user message(s)', toolRound, len(queued))
                currentMessages.append(_formatQueuedMessagesAsUserTurn(queued))
        logger.debug(
            'workbench round %d start (model=%s, in=%d, out=%d)',
            toolRound,
            resolvedModel,
            totalInputTokens,
            totalOutputTokens,
        )
        if toolRound == 1:
            toolNames = (
                [t.get('name') for t in tools]
                if isAnthropic
                else [as_dict(t.get('function', {})).get('name') for t in openaiTools]
            )
            logger.debug('workbench presenting %d tools to model: %s', len(toolNames), toolNames)
        with _trace.span('llm_wait', round=toolRound):
            if isAnthropic:
                response = await _callAnthropicWorkbench(
                    currentMessages,
                    systemText,
                    resolvedModel,
                    tools,
                    effectiveEffort,
                    provider=resolvedProvider,
                    emit=emit,
                    thinking_enabled=thinking_enabled,
                )
            elif isOpenai:
                response = await _callOpenaiWorkbench(
                    currentMessages,
                    systemText,
                    resolvedModel,
                    openaiTools,
                    effectiveEffort,
                    provider=resolvedProvider,
                    emit=emit,
                    thinking_enabled=thinking_enabled,
                )
            else:
                response = {'error': f'Unknown provider format for {resolvedProvider}'}
        if not isAnthropic and not isOpenai:
            if emit:
                emit({'type': 'error', 'message': f'Unknown provider format for {resolvedProvider}'})
            break
        if response.get('error'):
            if toolRound > 1:
                logger.warning(
                    'workbench model re-call failed after tool round %d: %s', toolRound - 1, response['error']
                )
            if emit:
                emit({'type': 'error', 'message': response['error']})
            break
        respUsage = as_dict(response.get('usage'), {})
        if respUsage:
            totalInputTokens += as_int(respUsage.get('input_tokens', 0))
            totalOutputTokens += as_int(respUsage.get('output_tokens', 0))
            finalContextTokens = as_int(respUsage.get('input_tokens', 0))
        if isAnthropic:
            assistantMsg = {'role': 'assistant', 'content': response.get('content', [])}
            contentBlocks = cast('list[dict[str, object]]', as_list(response.get('content', []), []))
            textContent = _extractText(contentBlocks)
            thinkingContent = _extractThinking(contentBlocks)
            toolUses = [b for b in contentBlocks if b.get('type') == 'tool_use']
        else:
            choices = as_list(response.get('choices', []), [])
            choice = as_dict(choices[0]) if choices else {}
            choiceMsg = as_dict(choice.get('message', {}))
            assistantMsg = {
                'role': 'assistant',
                'content': choiceMsg.get('content', ''),
                'tool_calls': choiceMsg.get('tool_calls', []),
            }
            textContent = as_str(response.get('text', ''))
            thinkingContent = as_str(response.get('thinking', '')) or as_str(
                choiceMsg.get('reasoning_content') or choiceMsg.get('reasoning'), ''
            )
            from app.adapters.reasoning_policy import attach_openai_reasoning

            attach_openai_reasoning(assistantMsg, thinkingContent)
            toolUses = cast('list[dict[str, object]]', as_list(response.get('tool_uses', []), []))
        if not toolUses:
            stop_reason = as_str(response.get('stop_reason') or response.get('finish_reason'))
            if toolRound > 1 and (not textContent) and (not thinkingContent):
                logger.warning(
                    'workbench model re-call returned empty content after tool round %d (no text, no tools)',
                    toolRound - 1,
                )
            elif toolRound > 1 and (not textContent) and thinkingContent:
                # Long thinking after tools often exhausts max_tokens — surface it
                # instead of ending the turn with only a process timeline.
                logger.warning(
                    'workbench thinking-only after tool round %d (stop_reason=%s, thinking_chars=%d)',
                    toolRound - 1,
                    stop_reason or 'unknown',
                    len(thinkingContent),
                )
                if stop_reason in ('max_tokens', 'length') or len(thinkingContent) > 2000:
                    emit(
                        {
                            'type': 'finalOutput',
                            'content': (
                                '\n\n_(Stopped after tools with reasoning but no final answer — '
                                'the output token budget was likely used up by thinking. '
                                'Try again, or lower thinking depth in the composer.)_'
                            ),
                        }
                    )
            currentMessages.append(assistantMsg)
            queued = drainQueuedMessages(sessionId, emit=emit)
            if queued:
                logger.debug('workbench mid-response: injecting %d queued user message(s) after text turn', len(queued))
                currentMessages.append(_formatQueuedMessagesAsUserTurn(queued))
                continue
            break
        toolResults: list[dict[str, object]] = []
        planSubmittedThisRound = False
        clarifySubmittedThisRound = False
        pending_regular: list[tuple[str, dict[str, object], str]] = []
        for tu in toolUses:
            if _isCancelled():
                break
            toolName = as_str(tu.get('name', ''))
            toolInput = as_dict(tu.get('input', {}))
            toolUseId = as_str(tu.get('id', f'toolu_{uuid.uuid4().hex[:16]}'))
            if toolName in ('submit_plan', 'submitPlan'):
                mode_now = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')
                # Full Access is a hard barrier: never open plan-approval UI.
                if mode_now == 'full':
                    msg = (
                        'submit_plan is disabled in Full Access mode. '
                        'Execute the work with tools directly — do not wait for plan approval.'
                    )
                    if emit:
                        emit(
                            {
                                'type': 'toolResult',
                                'id': toolUseId,
                                'name': toolName,
                                'content': msg,
                                'status': 'done',
                            }
                        )
                    toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': msg})
                    continue
                planPayload = toolInput.get('plan') or toolInput.get('steps') or toolInput
                submitPlan(session, planPayload if isinstance(planPayload, dict) else {'plan': planPayload})
                if emit:
                    emit({'type': 'planProposed', 'plan': session.plan})
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': 'Plan submitted. Awaiting user approval.',
                            'status': 'done',
                        }
                    )
                toolResults.append(
                    {'tool_use_id': toolUseId, 'role': 'tool', 'content': 'Plan submitted. Awaiting user approval.'}
                )
                planSubmittedThisRound = True
                continue
            if toolName in ('submit_clarify', 'ask_clarify'):
                submitClarify(session, toolInput)
                if emit:
                    emit({'type': 'clarifyProposed', 'clarify': session.clarify})
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': 'Question sent to the user. Awaiting their answer.',
                            'status': 'done',
                        }
                    )
                toolResults.append(
                    {
                        'tool_use_id': toolUseId,
                        'role': 'tool',
                        'content': 'Question sent to the user. Awaiting their answer.',
                    }
                )
                clarifySubmittedThisRound = True
                continue
            if toolName in ('submit_todos', 'submitTodos'):
                todosPayload = toolInput.get('todos') or toolInput.get('items') or toolInput
                if not isinstance(todosPayload, list):
                    todosPayload = [todosPayload] if todosPayload else []
                title = as_str(toolInput.get('title'), '')
                submitTodos(session, cast('list[dict[str, object]]', todosPayload), title=title)
                if emit:
                    emit({'type': 'todosUpdated', 'todos': session.todos})
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': 'Todo list saved.',
                            'status': 'done',
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': 'Todo list saved.'})
                continue
            if toolName in ('update_todos', 'updateTodos'):
                todosPayload = toolInput.get('todos') or toolInput.get('items') or toolInput
                if not isinstance(todosPayload, list):
                    todosPayload = [todosPayload] if todosPayload else []
                title = as_str(toolInput.get('title'), '')
                updateTodos(session, cast('list[dict[str, object]]', todosPayload), title=title)
                if emit:
                    emit({'type': 'todosUpdated', 'todos': session.todos})
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': 'Todo list updated.',
                            'status': 'done',
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': 'Todo list updated.'})
                continue
            blockedReason = _checkToolGuard(session, toolName, toolInput)
            if blockedReason:
                if emit:
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': f'[Blocked] {blockedReason}',
                            'error': blockedReason,
                            'status': 'blocked',
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': f'[Blocked] {blockedReason}'})
                continue
            pending_regular.append((toolName, toolInput, toolUseId))
        # Regular tools: chat_stages runs them in parallel when all are read-only.
        from app.services.workbench.chat_stages import run_regular_tools_stage

        async def _run_regular(toolName: str, toolInput: dict[str, object], toolUseId: str) -> dict[str, object]:
            if emit:
                emit({'type': 'toolCall', 'id': toolUseId, 'name': toolName, 'input': toolInput, 'status': 'running'})
            # Filesystem save point before mutating tools (W4 isolation)
            try:
                if isPlanModeBlocked(toolName, toolInput):
                    from app.services.workbench.checkpoint_service import create_checkpoint_for_tool

                    ck = create_checkpoint_for_tool(
                        session.id,
                        session.workspacePath or '',
                        toolName,
                        toolInput,
                    )
                    if ck:
                        meta = dict(as_dict(session.metadata) if session.metadata else {})
                        meta['lastCheckpointId'] = ck.get('id')
                        meta['lastCheckpointAt'] = ck.get('createdAt')
                        meta['lastCheckpointLabel'] = ck.get('label')
                        session.metadata = meta
                        if emit:
                            emit(
                                {
                                    'type': 'checkpoint',
                                    'id': ck.get('id'),
                                    'label': ck.get('label'),
                                    'fileCount': ck.get('fileCount'),
                                    'toolName': toolName,
                                }
                            )
            except Exception:
                logger.debug('checkpoint before tool failed', exc_info=True)
            try:
                from app.services.workbench.tool_guardrails import ToolCallTracker

                if session._tool_tracker is None:
                    session._tool_tracker = ToolCallTracker()
                tracker = session._tool_tracker
                guardStatus, guardMsg = tracker.check(toolName, toolInput)
                if guardStatus == 'block':
                    result = guardMsg
                    tracker.record_failure(toolName)
                else:
                    with _trace.span('tool_exec', tool=toolName):
                        result = await _executeTool(toolName, toolInput, session)
                    if isinstance(result, str) and result.startswith('Error:'):
                        tracker.record_failure(toolName)
                    if guardStatus == 'warn':
                        result = guardMsg + '\n' + result
            except Exception:
                with _trace.span('tool_exec', tool=toolName):
                    result = await _executeTool(toolName, toolInput, session)
            MAX_SSE_CONTENT = 100 * 1024
            contentTruncated = len(result) > MAX_SSE_CONTENT
            sseContent = result[:MAX_SSE_CONTENT]
            if contentTruncated:
                sseContent += '\n\n[... Tool result truncated at 100 KB — full length: {} bytes]'.format(len(result))
            if emit:
                providerSetup = None
                if toolName == 'setup_provider':
                    try:
                        parsed = json.loads(result)
                        if isinstance(parsed, dict) and parsed.get('providerId'):
                            providerSetup = parsed
                    except Exception:
                        providerSetup = None
                emit(
                    {
                        'type': 'toolResult',
                        'id': toolUseId,
                        'name': toolName,
                        'content': sseContent,
                        'contentTruncated': contentTruncated,
                        'contentFullLength': len(result),
                        'summary': str(result)[:2000],
                        'status': 'done',
                        'providerSetup': providerSetup,
                    }
                )
                if toolName.startswith('browser_'):
                    try:
                        parsed = json.loads(result)
                    except Exception:
                        parsed = None
                    if isinstance(parsed, dict) and parsed.get('status') == 'success':
                        emit(
                            {
                                'type': 'browserAction',
                                'id': toolUseId,
                                'name': toolName,
                                'input': toolInput,
                                'url': parsed.get('url'),
                                'title': parsed.get('title'),
                                'target': parsed.get('target'),
                                'screenshot': parsed.get('screenshot'),
                                'typed': parsed.get('typed'),
                                'selected': parsed.get('selected'),
                                'scrolled': parsed.get('scrolled'),
                                'status': 'success',
                            }
                        )
            # Truncate what the model sees next turn — SSE already truncates for the UI.
            historyContent = result
            if len(historyContent) > MAX_TOOL_RESULT_CHARS:
                historyContent = (
                    historyContent[:MAX_TOOL_RESULT_CHARS]
                    + f'\n\n[... Tool result truncated at {MAX_TOOL_RESULT_CHARS // 1024} KB '
                    f'— full length: {len(result)} bytes]'
                )
            return {'tool_use_id': toolUseId, 'role': 'tool', 'content': historyContent}

        toolResults.extend(
            await run_regular_tools_stage(
                pending_regular,
                _run_regular,
                is_cancelled=_isCancelled,
            )
        )
        if not toolResults:
            try:
                if hasattr(session, '_tool_tracker') and session._tool_tracker:
                    session._tool_tracker.record_text_response()
            except Exception:
                pass
            try:
                from app.services.daemon_manager import getManager

                manager = getManager()
                manager.increment_turns(session.id)
            except Exception:
                pass
            break
        currentMessages.append(assistantMsg)
        currentMessages.extend(toolResults)
        if planSubmittedThisRound:
            break
        if clarifySubmittedThisRound:
            break
    try:
        logger.debug('workbench turn complete: %d rounds, in=%d out=%d', toolRound, totalInputTokens, totalOutputTokens)
        session.messages = list(currentMessages)
        # Keep awaiting_approval if ask-mode left a pending mutation (ApprovalBanner).
        if session.pendingMutations:
            session.status = 'awaiting_approval'
        else:
            session.status = 'idle'
        session.updatedAt = _now()
        with _trace.span('persist'):
            # Persist session to SQLite (primary); JSON export is best-effort.
            try:
                saveSessions()
            except Exception as exc:
                logger.exception('workbench session persist failed; still emitting done')
                if emit:
                    emit(
                        {
                            'type': 'error',
                            'message': f'Session persist failed: {exc}',
                            'code': 'session_persist_failed',
                        }
                    )
            # Record activity so cognitive idle consolidation timer resets.
            try:
                from app.services.cognitive_boot import record_user_activity

                record_user_activity(session.id)
            except Exception:
                pass
            _emitSessionStatus(sessionId)
            if totalInputTokens > 0 or totalOutputTokens > 0:
                try:
                    from app.services.memory_store import record_usage

                    record_usage(
                        sessionId=session.id,
                        model=resolvedModel,
                        inputTokens=totalInputTokens,
                        outputTokens=totalOutputTokens,
                        contextTokens=finalContextTokens,
                    )
                    session.totalInputTokens += totalInputTokens
                    session.totalOutputTokens += totalOutputTokens
                except Exception:
                    logger.exception('workbench record_usage failed')
    finally:
        if emit:
            emit({'type': 'done', 'sessionId': sessionId})
    review_model = _backgroundTaskModel('reviewModel', resolvedModel)
    reflection_model = _backgroundTaskModel('reflectionModel', resolvedModel)
    auto_memory_model = _backgroundTaskModel('autoMemoryModel', resolvedModel)
    try:
        from app.services.memory.background_review import tryBackgroundReview, ReviewGates

        asyncio.create_task(
            tryBackgroundReview(
                session,
                list(currentMessages),
                gates=ReviewGates(turn_interval=3, tool_round_interval=6),
                llm_client=_makeReviewLlmClient(resolvedProvider, review_model),
            )
        )
    except Exception:
        pass
    try:
        from app.services.memory.self_evolution import reflectOnTurn
        from app.services.workbench.chat_stages import schedule_post_turn_side_effects

        schedule_post_turn_side_effects(
            session=session,
            messages=list(currentMessages),
            auto_memory_model=auto_memory_model or None,
            reflection_model=reflection_model or None,
            sync_auto_memory=_syncAutoMemory,
            reflect_on_turn=reflectOnTurn,
        )
    except Exception:
        pass
    # LLM sidebar title after the first exchange (placeholder titles only).
    try:
        from app.services.workbench.title_generator import schedule_auto_title_after_turn

        schedule_auto_title_after_turn(
            sessionId,
            list(currentMessages),
            provider=resolvedProvider,
            model=resolvedModel or '',
        )
    except Exception:
        logger.debug('schedule auto-title failed for %s', sessionId, exc_info=True)


def _syncAutoMemory(session: WorkbenchSession, messages: list[dict[str, object]], model: str = '') -> None:
    """Auto-memory sync — save conversation summaries and extract todos.

    Runs fire-and-forget after each workbench turn so it never delays
    the response. These lightweight rule-based extractions complement
    the heavier LLM-based background_review. The ``model`` argument is
    the resolved auto-memory model (falls back to the chat model) used
    for audit/metadata on the saved memories."""
    from app.services.memory.auto_memory import saveAutoMemory, extractAndSaveTodos
    from app.services.memory.cross_session_context import sync_from_turn

    try:
        extractAndSaveTodos(messages)
    except Exception:
        pass
    try:
        lastUserMsg = _lastUserMessageText(session)
        if lastUserMsg:
            # Full session id (includes date/time) so the model can tell which
            # conversation a memory came from; stamp for human-readable ordering.
            stamp = session.updatedAt or session.createdAt or ''
            # Keep the technical session id in the memory key; put the user's
            # words first so graph labels / previews stay beginner-readable.
            when = f' @ {stamp}' if stamp else ''
            summary = f'User asked: {lastUserMsg[:300]} (session {session.id}{when})'
            saveAutoMemory(
                f'conv_summary_{session.id}',
                summary,
                category='conversation',
                importance=0.3,
            )
        # Cross-session bridge: active_projects + current_context (not userProfile).
        sync_from_turn(
            workspace_path=as_str(getattr(session, 'workspacePath', '') or ''),
            last_user_text=lastUserMsg,
            session_title=as_str(getattr(session, 'title', '') or ''),
        )
    except Exception:
        pass


def _lastUserMessageText(session: WorkbenchSession) -> str:
    """Extract text content from the last user message in a session."""
    for msg in reversed(session.messages):
        if msg.get('role') == 'user':
            content = msg.get('content', '')
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                texts = [b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text']
                return ' '.join(texts)
    return ''


async def _executeTool(toolName: str, args: dict[str, object], session: WorkbenchSession) -> str:
    """Execute a workbench tool by dispatching to the correct handler.

    Two dispatch paths:
      * ``mcp__<server_id>__<tool>`` names route to the MCP client
        (``execute_mcp_tool_call``), which talks to the relevant MCP
        server subprocess over JSON-RPC.
      * everything else dispatches through ``tool_registry``.
    """
    from app.services.tool_registry import dispatch as dispatchTool
    from app.services.workbench.context import currentSessionId

    token = currentSessionId.set(session.id)
    try:
        from app.services.tools.mcp_client import executeMcpToolCall, isMcpToolName

        if isMcpToolName(toolName):
            return str(await executeMcpToolCall(toolName, args))
        result = await dispatchTool(toolName, args)
        return str(result)
    except Exception as exc:
        import traceback as _tb

        tbList = _tb.extract_tb(exc.__traceback__)
        lastFrame = tbList[-1] if tbList else None
        feedback = {
            'tool': toolName,
            'error_type': type(exc).__name__,
            'error_message': str(exc),
            'file': lastFrame.filename if lastFrame else None,
            'line': lastFrame.lineno if lastFrame else None,
            'function': lastFrame.name if lastFrame else None,
            'offending_code': lastFrame.line if lastFrame else None,
        }
        session._failure_feedback = feedback
        session._failure_feedback_age = 0
        return f'Tool {toolName} failed: {feedback["error_type"]}: {feedback["error_message"]}'
    finally:
        currentSessionId.reset(token)


def _bulk_paths_from_args(args: dict[str, object]) -> list[str]:
    """Collect path-like identifiers from bulk tool args for grants/previews."""
    paths: list[str] = []
    for key in ('paths', 'sessionIds', 'daemonIds', 'urls', 'names'):
        raw = args.get(key)
        if isinstance(raw, list):
            paths.extend(str(x).strip() for x in raw if str(x).strip())
    files = args.get('files') or args.get('renames') or args.get('items')
    if isinstance(files, list):
        for entry in files:
            if not isinstance(entry, dict):
                continue
            p = (
                as_str(entry.get('path'))
                or as_str(entry.get('sessionId'))
                or as_str(entry.get('filePath'))
                or as_str(entry.get('url'))
                or as_str(entry.get('name'))
            )
            if p:
                paths.append(p)
    # Deduplicate, keep order
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def _mutation_grant_key(toolName: str, args: dict[str, object] | None) -> str:
    """Stable key for once/session/always grants (tool + primary path)."""
    args = args or {}
    # Sandbox escape grants use a fingerprint path so Once/This chat/Always work.
    path = as_str(args.get('path'))
    if path.startswith('sandbox:unsandboxed:') or as_bool(args.get('sandboxEscape')):
        if path.startswith('sandbox:unsandboxed:'):
            return f'{toolName}:{path}'
        try:
            from app.services.sandbox import unsandboxed_grant_key

            return f'{toolName}:{unsandboxed_grant_key(as_str(args.get("command")))}'
        except Exception:
            return f'{toolName}:sandbox:unsandboxed:*'
    bulk_paths = _bulk_paths_from_args(args)
    if bulk_paths:
        # Grant is scoped to this exact set of targets (sorted for stability).
        joined = ','.join(sorted(bulk_paths)[:40])
        return f'{toolName}:{joined}'
    path = (
        path
        or as_str(args.get('file_path'))
        or as_str(args.get('filePath'))
        or as_str(args.get('file'))
        or as_str(args.get('target'))
        or '*'
    )
    return f'{toolName}:{path}'


def _mutation_preview(toolName: str, args: dict[str, object] | None) -> str:
    """Short human preview for the approval UI (file content snippet, command, …)."""
    args = args or {}
    name = toolName.lower()
    op = as_str(args.get('operation')).lower()
    bulk_paths = _bulk_paths_from_args(args)
    if bulk_paths and (
        name in {'bulk', 'write_files', 'delete_sessions', 'rename_sessions', 'kill_daemons'}
        or op in {'write_files', 'delete_sessions', 'rename_sessions', 'kill_daemons'}
        or 'write_files' in name
        or 'delete_sessions' in name
    ):
        label = op or name
        listing = '\n'.join(f'• {p}' for p in bulk_paths[:25])
        more = f'\n…and {len(bulk_paths) - 25} more' if len(bulk_paths) > 25 else ''
        return f'Bulk {label} ({len(bulk_paths)} item(s)):\n{listing}{more}'
    path = (
        as_str(args.get('path'))
        or as_str(args.get('file_path'))
        or as_str(args.get('filePath'))
        or as_str(args.get('file'))
    )
    if any(m in name for m in ('write', 'edit', 'create', 'patch', 'str_replace')):
        content = (
            as_str(args.get('content'))
            or as_str(args.get('new_str'))
            or as_str(args.get('new_string'))
            or as_str(args.get('text'))
        )
        head = content[:1200] if content else ''
        if path and head:
            return f'Write {path}\n\n{head}{"…" if len(content) > 1200 else ""}'
        if path:
            return f'Modify {path}'
        return f'{toolName} (file change)'
    if any(m in name for m in ('bash', 'shell', 'command', 'exec', 'terminal')):
        cmd = as_str(args.get('command')) or as_str(args.get('cmd')) or as_str(args.get('input'))
        return f'Run: {cmd[:500]}' if cmd else f'Run {toolName}'
    if path:
        return f'{toolName} → {path}'
    return toolName


def _get_tool_grants(session: WorkbenchSession) -> dict[str, list[str]]:
    meta = as_dict(session.metadata) if session.metadata else {}
    raw = as_dict(meta.get('toolGrants')) if meta.get('toolGrants') is not None else {}
    return {
        'once': [str(x) for x in as_list(raw.get('once'))],
        'session': [str(x) for x in as_list(raw.get('session'))],
        'always': [str(x) for x in as_list(raw.get('always'))],
    }


def _set_tool_grants(session: WorkbenchSession, grants: dict[str, list[str]]) -> None:
    meta = dict(as_dict(session.metadata) if session.metadata else {})
    meta['toolGrants'] = {
        'once': list(grants.get('once') or []),
        'session': list(grants.get('session') or []),
        'always': list(grants.get('always') or []),
    }
    session.metadata = meta


def _load_always_grants_for_workspace(workspace_path: str) -> list[str]:
    if not workspace_path:
        return []
    try:
        from app.services.config_service import getConfig

        cfg = getConfig()
        store = as_dict(cfg.get('toolAlwaysGrants')) if cfg.get('toolAlwaysGrants') is not None else {}
        # Normalize path keys loosely
        for key, vals in store.items():
            if str(key).replace('\\', '/').rstrip('/').lower() == workspace_path.replace('\\', '/').rstrip('/').lower():
                return [str(v) for v in as_list(vals)]
        return [str(v) for v in as_list(store.get(workspace_path))]
    except Exception:
        return []


def _save_always_grant(workspace_path: str, key: str) -> None:
    if not workspace_path or not key:
        return
    try:
        from app.services.config_service import getConfig, saveConfig

        cfg = getConfig()
        store = as_dict(cfg.get('toolAlwaysGrants')) if cfg.get('toolAlwaysGrants') is not None else {}
        existing = [str(v) for v in as_list(store.get(workspace_path))]
        if key not in existing:
            existing.append(key)
        store[workspace_path] = existing
        # Also store tool:* wildcard companion if user chose path-specific
        cfg['toolAlwaysGrants'] = store
        saveConfig(cfg)
    except Exception:
        logger.debug('failed to persist always grant', exc_info=True)


def list_always_grants() -> dict[str, object]:
    """List path-scoped always-grants for Settings UI (why blocked / revoke)."""
    try:
        from app.services.config_service import getConfig

        cfg = getConfig()
        store = as_dict(cfg.get('toolAlwaysGrants')) if cfg.get('toolAlwaysGrants') is not None else {}
    except Exception:
        store = {}
    workspaces: list[dict[str, object]] = []
    for ws, vals in store.items():
        grants: list[dict[str, str]] = []
        for raw in as_list(vals):
            key = str(raw)
            if ':' in key:
                tool, path = key.split(':', 1)
            else:
                tool, path = key, '*'
            grants.append({'key': key, 'tool': tool, 'path': path})
        workspaces.append({'workspacePath': str(ws), 'grants': grants})
    return {'workspaces': workspaces}


def revoke_always_grant(workspace_path: str, key: str) -> dict[str, object]:
    """Remove one always-grant key for a workspace folder."""
    if not workspace_path or not key:
        return {'ok': False, 'error': 'workspacePath and key required'}
    try:
        from app.services.config_service import getConfig, saveConfig

        cfg = getConfig()
        store = as_dict(cfg.get('toolAlwaysGrants')) if cfg.get('toolAlwaysGrants') is not None else {}
        # Loose path match
        matched_key = None
        for k in list(store.keys()):
            if str(k).replace('\\', '/').rstrip('/').lower() == workspace_path.replace('\\', '/').rstrip('/').lower():
                matched_key = k
                break
        if matched_key is None:
            matched_key = workspace_path
        existing = [str(v) for v in as_list(store.get(matched_key))]
        if key not in existing:
            return {'ok': False, 'error': 'grant not found', 'workspaces': list_always_grants()['workspaces']}
        existing = [v for v in existing if v != key]
        if existing:
            store[matched_key] = existing
        else:
            store.pop(matched_key, None)
        cfg['toolAlwaysGrants'] = store
        saveConfig(cfg)
        return {'ok': True, 'revoked': key, 'workspaces': list_always_grants()['workspaces']}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


def has_tool_grant(session: WorkbenchSession, toolName: str, args: dict[str, object] | None) -> bool:
    """True if once/session/always grant covers this tool call (consumes once grants)."""
    key = _mutation_grant_key(toolName, args)
    tool_star = f'{toolName}:*'
    grants = _get_tool_grants(session)
    # once — consume on match
    once = list(grants.get('once') or [])
    if key in once or tool_star in once:
        if key in once:
            once.remove(key)
        elif tool_star in once:
            once.remove(tool_star)
        grants['once'] = once
        _set_tool_grants(session, grants)
        return True
    session_g = grants.get('session') or []
    if key in session_g or tool_star in session_g:
        return True
    always = list(grants.get('always') or []) + _load_always_grants_for_workspace(session.workspacePath or '')
    if key in always or tool_star in always:
        return True
    return False


def add_tool_grant(
    session: WorkbenchSession,
    toolName: str,
    args: dict[str, object] | None,
    scope: str = 'once',
) -> None:
    """Record a user grant. scope: once | session | always."""
    key = _mutation_grant_key(toolName, args)
    scope_n = (scope or 'once').strip().lower()
    if scope_n not in ('once', 'session', 'always'):
        scope_n = 'once'
    grants = _get_tool_grants(session)
    bucket = list(grants.get(scope_n) or [])
    if key not in bucket:
        bucket.append(key)
    grants[scope_n] = bucket
    _set_tool_grants(session, grants)
    if scope_n == 'always' and session.workspacePath:
        _save_always_grant(session.workspacePath, key)


def _checkToolGuard(session: WorkbenchSession, toolName: str, args: dict[str, object]) -> str | None:
    """Check if a tool execution is blocked by guard mode or permissions.

    Returns None if allowed, or a string reason if blocked.
    In ask mode, creates a pending mutation for the ApprovalBanner UI.
    """
    # Codex read-only sandbox: block mutating file tools. Shell still goes through
    # run_command soft/OS preflight (which denies redirects / mutating prefixes).
    sandbox_mode = (getattr(session, 'sandboxMode', None) or 'workspace-write').strip().lower()
    if sandbox_mode in ('read-only', 'readonly', 'read'):
        name = (toolName or '').lower()
        if name in {
            'write_file',
            'edit_file',
            'create_file',
            'str_replace',
            'str_replace_editor',
            'apply_patch',
            'patch_file',
            'delete_file',
            'remove_file',
            'move_file',
            'rename_file',
        }:
            return (
                f"Tool '{toolName}' is blocked by read-only sandbox. "
                'Switch sandbox mode to Workspace or Full access to make changes.'
            )
    if session.guardMode == 'plan' and (not session.planApproved) and isPlanModeBlocked(toolName, args):
        return (
            f"Tool '{toolName}' is destructive and cannot run in plan mode. "
            'Finish investigating with non-destructive tools, then call `submit_plan` '
            'and wait for the user to approve before executing.'
        )
    # Edit automatically: file edits proceed; shell/commands still need approval.
    if session.guardMode == 'edit' and isShellMutationTool(toolName, args):
        if has_tool_grant(session, toolName, args):
            return None
        key = _mutation_grant_key(toolName, args)
        for pm in session.pendingMutations:
            if not isinstance(pm, dict):
                continue
            if as_str(pm.get('toolName')) == toolName and _mutation_grant_key(
                toolName, as_dict(pm.get('args'))
            ) == key:
                return (
                    f"Tool '{toolName}' is waiting for the user's approval in the app. "
                    'Do not retry until the user approves or rejects it.'
                )
        mutation = createPendingMutation(session, toolName, args)
        preview = _mutation_preview(toolName, args)
        if mutation is not None:
            mutation['preview'] = preview
            mutation['grantKey'] = key
            saveSessions()
            _emitSessionStatus(session.id)
        return (
            f"Tool '{toolName}' requires your approval before it can run. "
            'A permission prompt was shown to the user (Accept / Reject, with once / this chat / always). '
            'Do not retry. When the user accepts, the tool will be executed with the proposed arguments '
            'and you will receive the result automatically.'
        )
    if session.guardMode == 'ask' and isPlanModeBlocked(toolName, args):
        if has_tool_grant(session, toolName, args):
            return None
        # Avoid stacking duplicate pending mutations for the same tool+path
        key = _mutation_grant_key(toolName, args)
        for pm in session.pendingMutations:
            if not isinstance(pm, dict):
                continue
            if as_str(pm.get('toolName')) == toolName and _mutation_grant_key(
                toolName, as_dict(pm.get('args'))
            ) == key:
                return (
                    f"Tool '{toolName}' is waiting for the user's approval in the app. "
                    'Do not retry until the user approves or rejects it.'
                )
        mutation = createPendingMutation(session, toolName, args)
        preview = _mutation_preview(toolName, args)
        if mutation is not None:
            mutation['preview'] = preview
            mutation['grantKey'] = key
            saveSessions()
            _emitSessionStatus(session.id)
        return (
            f"Tool '{toolName}' requires your approval before it can run. "
            'A permission prompt was shown to the user (Accept / Reject, with once / this chat / always). '
            'Do not retry. When the user accepts, the tool will be executed with the proposed arguments '
            'and you will receive the result automatically.'
        )
    return None


def submitPlan(session: WorkbenchSession, planData: dict[str, object]) -> None:
    """Store a plan on the session. v1.1: drop prior execution state and working memory."""
    session.plan = planData
    session.planApproved = False
    session._execution_state = None
    session._working_memory = None
    session.updatedAt = _now()
    try:
        from app.services import aug_artifact_service

        aug_artifact_service.savePlan(session.workspacePath or None, session.id, planData, status='pending')
    except Exception:
        pass
    _emitSessionStatus(session.id)


def submitClarify(session: WorkbenchSession, clarifyData: dict[str, object]) -> None:
    """Store a clarification question on the session for the user to answer.

    Mirrors ``submitPlan``: the payload is persisted on the session and an
    SSE ``clarifyProposed`` event is emitted by the tool loop. The UI renders
    a question with up to 5 numbered choices plus a free-text "Something
    else" input, then feeds the user's answer back into the model as a
    queued user message.

    Multiple ``ask_clarify`` / ``submit_clarify`` calls in one turn append
    questions instead of overwriting — same class of bug as multi-approvals
    only showing the first card.
    """
    MAX_CLARIFY_CHOICES = 5
    if not isinstance(clarifyData, dict):
        clarifyData = {}

    def _normalize_questions(raw: object) -> list[dict[str, object]]:
        out: list[dict[str, object]] = []
        if isinstance(raw, list) and raw:
            for q in raw:
                if not isinstance(q, dict):
                    continue
                item: dict[str, object] = {'question': str(q.get('question', ''))}
                raw_choices = q.get('choices') or []
                if isinstance(raw_choices, list):
                    item['choices'] = [str(c) for c in raw_choices[:MAX_CLARIFY_CHOICES]]
                out.append(item)
            return out
        return []

    incoming = _normalize_questions(clarifyData.get('questions'))
    if not incoming:
        question = clarifyData.get('question') or ''
        raw_choices = clarifyData.get('choices') or []
        choices = (
            [str(c) for c in raw_choices[:MAX_CLARIFY_CHOICES]]
            if isinstance(raw_choices, list)
            else []
        )
        if str(question).strip() or choices:
            incoming = [{'question': str(question), 'choices': choices}]

    # Merge with any unanswered questions already on the session.
    existing_raw = as_dict(session.clarify) if session.clarify is not None else {}
    existing = _normalize_questions(existing_raw.get('questions'))
    if not existing and (existing_raw.get('question') or existing_raw.get('choices')):
        existing = [
            {
                'question': str(existing_raw.get('question') or ''),
                'choices': [
                    str(c) for c in as_list(existing_raw.get('choices'), [])[:MAX_CLARIFY_CHOICES]
                ],
            }
        ]

    merged = existing + incoming
    # Always prefer the multi-question shape so stacked clarify calls render
    # as a pager instead of silently replacing the previous question.
    payload: dict[str, object] = (
        {'questions': merged} if merged else {'question': '', 'choices': []}
    )
    context_summary = clarifyData.get('contextSummary') or existing_raw.get('contextSummary')
    if context_summary:
        payload['contextSummary'] = str(context_summary)
    session.clarify = payload
    session.updatedAt = _now()
    _emitSessionStatus(session.id)


def submitTodos(session: WorkbenchSession, todosData: list[dict[str, object]], *, title: str = '') -> None:
    """Store a todo list on the session and persist it to `.aug/todoList/`."""
    if not isinstance(todosData, list):
        todosData = [todosData] if todosData else []
    session.todos = todosData
    session.updatedAt = _now()
    try:
        from app.services import aug_artifact_service

        aug_artifact_service.saveTodos(
            session.workspacePath or None, session.id, todosData, title=title, status='active'
        )
    except Exception:
        pass
    _emitSessionStatus(session.id)


def updateTodos(session: WorkbenchSession, todosData: list[dict[str, object]], *, title: str = '') -> None:
    """Replace the session's todo list in place and re-persist it."""
    submitTodos(session, todosData, title=title)


def approveWorkbenchPlan(sessionId: str) -> bool:
    """Approve a pending plan."""
    session = _sessions.get(sessionId)
    if not session or not session.plan:
        return False
    session.planApproved = True
    session.updatedAt = _now()
    saveSessions()
    # Reflect the approval on the persisted .aug artifact so the Plans
    # section doesn't keep showing it as "pending".
    try:
        from app.services import aug_artifact_service

        aug_artifact_service.updatePlanStatus(session.workspacePath or None, sessionId, 'approved')
    except Exception:
        pass
    _emitSessionStatus(sessionId)
    return True


def rejectWorkbenchPlan(sessionId: str) -> bool:
    """Reject a pending plan. v1.1: drop prior execution state and working memory."""
    session = _sessions.get(sessionId)
    if not session:
        return False
    session.plan = None
    session.planApproved = False
    session._execution_state = None
    session._working_memory = None
    session.updatedAt = _now()
    try:
        from app.services import aug_artifact_service

        aug_artifact_service.deleteForSession(session.workspacePath or None, sessionId)
    except Exception:
        pass
    saveSessions()
    _emitSessionStatus(sessionId)
    return True


def recordMutation(session: WorkbenchSession, toolName: str, args: dict[str, object], result: str) -> None:
    """Record a mutation in the session's mutation log."""
    session.mutationLog.append({'toolName': toolName, 'args': args, 'result': str(result)[:500], 'timestamp': _now()})
    session.mutationCount += 1


def createPendingMutation(
    session: WorkbenchSession, toolName: str, args: dict[str, object]
) -> dict[str, object] | None:
    """Create a pending mutation token requiring approval."""
    token = f'mt_{uuid.uuid4().hex[:16]}'
    mutation: dict[str, object] = {
        'token': token,
        'toolName': toolName,
        'args': args,
        'createdAt': _now(),
        'ttl': 300,
        'preview': _mutation_preview(toolName, args),
        'grantKey': _mutation_grant_key(toolName, args),
    }
    session.pendingMutations.append(mutation)
    session.status = 'awaiting_approval'
    saveSessions()
    _emitSessionStatus(session.id)
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime(
            'session.updated',
            sessionId=session.id,
            status='awaiting_approval',
            pendingToken=token,
            pendingTool=toolName,
        )
        emit_invalidate('session-status', 'workbench-session', session_id=session.id)
    except Exception:
        pass
    return mutation


def consumePendingMutation(
    token: str,
    reject: bool = False,
    scope: str = 'once',
) -> dict[str, object] | None:
    """Approve or reject a pending mutation.

    On approve, records a grant (once|session|always) and returns tool args so the
    caller can **execute immediately** (pre-apply). On reject, discards the pending
    change without running the tool.
    Returns a small result dict or None if token not found.
    """
    for session in _sessions.values():
        for i, pm in enumerate(session.pendingMutations):
            if not isinstance(pm, dict) or pm.get('token') != token:
                continue
            tool_name = as_str(pm.get('toolName'))
            args = as_dict(pm.get('args')) if pm.get('args') is not None else {}
            preview = as_str(pm.get('preview'))
            session.pendingMutations.pop(i)
            # Keep awaiting_approval while more mutations remain — otherwise the
            # UI hides the rest of the stack after the first Accept/Reject.
            still_pending = any(
                isinstance(m, dict) and m.get('token') for m in session.pendingMutations
            )
            session.status = 'awaiting_approval' if still_pending else 'idle'
            if reject:
                saveSessions()
                _emitSessionStatus(session.id)
                return {
                    'status': 'rejected',
                    'sessionId': session.id,
                    'toolName': tool_name,
                    'args': args,
                    'preview': preview,
                    'remainingPending': len(session.pendingMutations),
                }
            add_tool_grant(session, tool_name, args, scope=scope)
            saveSessions()
            _emitSessionStatus(session.id)
            return {
                'status': 'approved',
                'sessionId': session.id,
                'toolName': tool_name,
                'args': args,
                'preview': preview,
                'scope': (scope or 'once').strip().lower(),
                'grantKey': _mutation_grant_key(tool_name, args),
                'remainingPending': len(session.pendingMutations),
            }
    return None


async def execute_approved_mutation(
    session: WorkbenchSession,
    tool_name: str,
    args: dict[str, object] | None,
) -> str:
    """Run a user-accepted mutating tool with stored args (pre-apply Accept).

    Creates a filesystem checkpoint when possible, then dispatches the tool.
    """
    tool_name = (tool_name or '').strip()
    args = dict(args or {})
    if not tool_name:
        return 'Error: no tool name on approved mutation'
    try:
        if isPlanModeBlocked(tool_name, args):
            from app.services.workbench.checkpoint_service import create_checkpoint_for_tool

            ck = create_checkpoint_for_tool(
                session.id,
                session.workspacePath or '',
                tool_name,
                args,
            )
            if ck:
                meta = dict(as_dict(session.metadata) if session.metadata else {})
                meta['lastCheckpointId'] = ck.get('id')
                meta['lastCheckpointAt'] = ck.get('createdAt')
                meta['lastCheckpointLabel'] = ck.get('label')
                session.metadata = meta
    except Exception:
        logger.debug('checkpoint before approved mutation failed', exc_info=True)
    result = await _executeTool(tool_name, args, session)
    try:
        recordMutation(session, tool_name, args, result)
    except Exception:
        pass
    return str(result)


def setWorkbenchGoal(session: WorkbenchSession, condition: str) -> None:
    """Set an active goal on the session."""
    session.goal = condition
    session.updatedAt = _now()
    saveSessions()


def clearWorkbenchGoal(session: WorkbenchSession, reason: str = '') -> None:
    """Clear the active goal."""
    session.goal = ''
    session.updatedAt = _now()
    saveSessions()


def getWorkbenchGoalStatus(sessionId: str) -> dict[str, object] | None:
    """Return current goal status."""
    session = _sessions.get(sessionId)
    if not session:
        return None
    return {'goal': session.goal, 'active': bool(session.goal)}


def updateWorkbenchGoal(sessionId: str, action: str, condition: str = '') -> dict[str, object] | None:
    """Set/clear/status for goals."""
    session = _sessions.get(sessionId)
    if not session:
        return None
    if action == 'set' and condition:
        setWorkbenchGoal(session, condition)
    elif action == 'clear':
        clearWorkbenchGoal(session, 'user requested')
    return getWorkbenchGoalStatus(sessionId)


def getWorkbenchActivity(args: dict[str, object] | None = None) -> dict[str, object]:
    """Return recent workbench activity."""
    return {
        'sessions': len(_sessions),
        'active': sum((1 for s in _sessions.values() if s.status == 'streaming')),
        'pending_approvals': sum((1 for s in _sessions.values() if s.status == 'awaiting_approval')),
    }


def listProxyCapabilities() -> dict[str, object]:
    """List all tools grouped by source with mutation flags and token estimates.

    Phase 1 rewrite — port of workbench.js:1540 behavior:
    - Groups tools by source category (file, shell, memory, web, agent, bridge, mcp)
    - Flags mutating vs non-mutating per tool
    - Estimates per-tool schema token cost
    - Includes agent registry count
    """
    from app.services.tool_registry import listTools as regListTools

    _MUTATING_TOOLS = frozenset(
        {
            'write_file',
            'edit_file',
            'delete_file',
            'create_file',
            'run_command',
            'save_memory',
            'save_fact',
            'update_heuristics',
            'update_state',
            'write_scratchpad',
            'delete_memory',
            'delete_session',
            'delete_sessions',
            'delete_folder',
            'write_files',
            'rename_sessions',
            'kill_daemons',
            'bulk',
            'submit_plan',
            'approve_plan',
            'reject_plan',
            # load_skill is read-only knowledge load — not mutating
            'skill_manage',
            'spawn_subagent',
            'spawn_daemon',
            'kill_daemon',
            'write_blackboard',
            'clear_blackboard',
        }
    )
    allTools = regListTools()
    grouped: dict[str, list[dict[str, object]]] = {}
    for tool in allTools:
        name = tool.get('name', '') if isinstance(tool, dict) else str(tool)
        if not name:
            continue
        if name in (
            'read_file',
            'write_file',
            'list_directory',
            'search_files',
            'edit_file',
            'delete_file',
            'create_file',
        ):
            group = 'file'
        elif name in ('run_command',):
            group = 'shell'
        elif name in (
            'memory_search',
            'fact_search',
            'context_read',
            'brain_query',
            'save_memory',
            'delete_memory',
            'save_fact',
            'update_heuristics',
        ):
            group = 'memory'
        elif name in ('load_skill', 'load_skills', 'list_skills', 'skill_manage'):
            group = 'skill'
        elif name in ('web_fetch', 'web_search'):
            group = 'web'
        elif name in ('spawn_subagent', 'create_agent', 'list_agents'):
            group = 'agent'
        elif name in ('spawn_daemon', 'list_daemons', 'kill_daemon'):
            group = 'daemon'
        elif name in ('tool_search', 'tool_describe', 'toolCall'):
            group = 'bridge'
        elif as_str(name).startswith('mcp__'):
            group = 'mcp'
        else:
            group = 'other'
        isMutating = name in _MUTATING_TOOLS
        schemaStr = str(tool.get('input_schema', tool.get('parameters', {})))
        estimatedTokens = len(schemaStr) // 4 + 50
        entry = {'name': name, 'mutating': isMutating, 'estimated_tokens': estimatedTokens}
        if group not in grouped:
            grouped[group] = []
        grouped[group].append(entry)
    agentCount = 0
    try:
        from app.services.tools.agent_registry import listAgents

        agentCount = len(listAgents())
    except Exception:
        pass
    return {
        'tools_by_group': grouped,
        'total_tools': len(allTools),
        'mutating_tools': sum((1 for t in allTools if (t.get('name') if isinstance(t, dict) else t) in _MUTATING_TOOLS)),
        'estimated_total_tokens': sum((len(str(t)) // 4 + 50 for t in allTools)),
        'agent_count': agentCount,
    }


def get_session() -> WorkbenchSession | None:
    """Get the active workbench session from the current context.

    Used by the update_state tool to read/write execution state.
    In a production setting this would use a contextvar; for now it
    returns the most recently touched session as a best-effort approach,
    since tools run synchronously within a session's turn.
    """
    if not _sessions:
        return None
    try:
        return list(_sessions.values())[-1]
    except (IndexError, ValueError):
        return None


async def updateSessionState(session: WorkbenchSession, executionState: dict) -> None:
    """Update execution state on a session with an asyncio.Lock.

    Phase 5: ``asyncio.Lock`` per session around state mutations —
    parallel ``update_state`` and ``write_scratchpad`` calls are serialized
    per session, preventing dropped state updates. Lock timeout of 5 seconds
    prevents deadlock.
    """
    import asyncio

    if session._state_lock is None:
        session._state_lock = asyncio.Lock()
    try:
        await asyncio.wait_for(session._state_lock.acquire(), timeout=5.0)
        try:
            session._execution_state = executionState
            if hasattr(session, 'save') and callable(session.save):
                session.save()
        finally:
            session._state_lock.release()
    except asyncio.TimeoutError:
        pass
    except RuntimeError:
        pass
