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
import random
import re
import time
import uuid
from typing import Any, Callable, Coroutine, cast

from app.json_narrowing import as_bool, as_dict, as_int, as_list, as_str
from app.services.tool_policy import is_mutating, is_shell_mutation
from app.services.workbench import providers as _providers_mod
from app.services.workbench import sessions as _sessions_mod
from app.services.workbench.effort import (
    effort_to_openai_reasoning_effort,
    effort_to_prompt_instruction,
    effort_to_thinking_budget,
    resolve_effective_effort,
)
from app.services.workbench.sessions import (
    WorkbenchSession,
    _emitSessionStatus,
    _now,
    _sessions,
    createWorkbenchSession,
    getWorkbenchSession,
    saveSessions,
)
from app.type_aliases import JsonValue

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


# ── Model-call retry policy (rate limits & transient upstream failures) ──

_MODEL_RETRY_STATUSES = {408, 429, 500, 502, 503, 504}
_MODEL_RETRY_MARKERS = (
    'rate limit',
    'rate_limit',
    'too many requests',
    'timeout',
    'timed out',
    'temporarily',
    'connection',
    'overloaded',
    'service unavailable',
    'bad gateway',
)


def _isRetryableModelError(response: dict[str, object]) -> bool:
    """True when a failed model sub-call is worth retrying (429/5xx/network)."""
    if not response.get('error'):
        return False
    status = response.get('errorStatus')
    if isinstance(status, int) and status in _MODEL_RETRY_STATUSES:
        return True
    msg = as_str(response.get('error')).lower()
    return any((marker in msg for marker in _MODEL_RETRY_MARKERS))


def _modelRetryPolicy() -> dict[str, int]:
    """Retry policy with optional config.json overrides (workbench.retry)."""
    policy = {'maxRetries': 10, 'baseDelayMs': 1000, 'maxDelayMs': 30000}
    try:
        from app.services import config_service

        cfg = as_dict(as_dict(config_service.getConfig().get('workbench')).get('retry'))
        for key in policy:
            val = cfg.get(key)
            if isinstance(val, int) and val >= 0:
                policy[key] = val
    except Exception:
        pass
    return policy


def _modelRetryDelayMs(attempt: int, response: dict[str, object], policy: dict[str, int]) -> int:
    """Backoff before retry ``attempt`` (1-based): honor Retry-After, else exponential."""
    retryAfter = response.get('retryAfterMs')
    if isinstance(retryAfter, int) and retryAfter > 0:
        return min(retryAfter, policy['maxDelayMs'])
    base = min(policy['baseDelayMs'] * 2 ** max(0, attempt - 1), policy['maxDelayMs'])
    return base + random.randint(0, 400)


async def _interruptibleSleep(seconds: float) -> None:
    """Sleep that returns early when the turn is cancelled (Stop button)."""
    from app.lib.async_subprocess import current_subprocess_cancel

    event = current_subprocess_cancel.get()
    if event is None:
        await asyncio.sleep(seconds)
        return
    try:
        await asyncio.wait_for(event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


def isShellMutationTool(toolName: str, args: dict[str, object] | None = None) -> bool:
    """Thin wrapper — delegates to the unified tool_policy module."""
    from app.services.tool_policy import is_shell_mutation
    return is_shell_mutation(toolName, args)


def isPlanModeBlocked(toolName: str, args: dict[str, object] | None = None) -> bool:
    """Thin wrapper — delegates to the unified tool_policy module."""
    from app.services.tool_policy import is_mutating
    return is_mutating(toolName, args)


# The single file the model may write in plan mode: the plan markdown that
# submit_plan hands to the user. Session-scoped (.aug/plans/<sessionId>.md)
# so sessions sharing a workspace never see each other's plans — the old
# fixed plan.md leaked one session's plan into every other session that
# entered plan mode. The model learns its exact path from the
# enter_plan_mode tool result.
PLAN_FILE_DIR = '.aug/plans'


def plan_file_relpath(sessionId: str) -> str:
    """Workspace-relative plan markdown path for one session."""
    import re

    safe = re.sub(r'[^A-Za-z0-9_.-]', '_', as_str(sessionId or '').strip()) or 'session'
    return f'{PLAN_FILE_DIR}/{safe}.md'


_PLAN_FILE_WRITE_TOOLS = {
    'write_file',
    'edit_file',
    'create_file',
    'str_replace',
    'str_replace_editor',
    'apply_patch',
    'patch_file',
}


def plan_file_path(workspacePath: str | None, sessionId: str) -> str | None:
    """Absolute path of the session's plan markdown file (None without a workspace)."""
    import os

    workspace = as_str(workspacePath or '').strip()
    if not workspace:
        return None
    return os.path.normpath(os.path.join(workspace, *plan_file_relpath(sessionId).split('/')))


def is_plan_file_write(
    session: object, toolName: str, args: dict[str, object] | None
) -> bool:
    """True only if this call writes exactly this session's plan markdown file.

    This is the sole write allowed in plan mode. Fails closed: any tool we
    cannot prove targets ``<workspace>/.aug/plans/<sessionId>.md`` stays blocked.
    """
    import os

    if (toolName or '').lower() not in _PLAN_FILE_WRITE_TOOLS:
        return False
    allowed = plan_file_path(
        getattr(session, 'workspacePath', None), as_str(getattr(session, 'id', None) or '')
    )
    if not allowed:
        return False
    a = as_dict(args or {})
    raw = as_str(a.get('path') or a.get('file_path') or a.get('filePath'))
    if not raw:
        return False
    workspace = as_str(getattr(session, 'workspacePath', None) or '').strip()
    target = raw if os.path.isabs(raw) else os.path.join(workspace, raw)
    try:
        return os.path.normcase(os.path.normpath(target)) == os.path.normcase(allowed)
    except Exception:
        return False


_git_probe_cache: dict[str, tuple[float, str, str]] = {}
_GIT_PROBE_TTL_S = 60


def _probe_workspace_git(workspace_path: str) -> tuple[str, str]:
    """VCS state + recent git activity for a workspace, cached briefly.

    buildSystemPrompt runs these synchronous subprocess probes on the async
    hot path; the TTL cache keeps them at one run per 60s per workspace
    instead of once per turn.
    """
    import subprocess
    import time as _time

    now = _time.monotonic()
    cached = _git_probe_cache.get(workspace_path)
    if cached is not None and now - cached[0] < _GIT_PROBE_TTL_S:
        return cached[1], cached[2]
    vcs_info = ''
    whats_new = ''
    try:
        branch = subprocess.run(
            ['git', 'branch', '--show-current'], cwd=workspace_path, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        status = subprocess.run(
            ['git', 'status', '--short'], cwd=workspace_path, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if branch:
            dirty = ' (dirty)' if status else ' (clean)'
            vcs_info = f'{branch}{dirty}'
    except Exception:
        logger.debug('prompt: git vcs probe failed', exc_info=True)
    try:
        log = subprocess.run(
            ['git', 'log', '--oneline', '--since=24 hours ago', '--max-count=10'],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
        if log:
            lines = log.split('\n')
            whats_new = 'Recent git activity:\n' + '\n'.join((f'  - {line}' for line in lines))
    except Exception:
        logger.debug('prompt: git log failed', exc_info=True)
    _git_probe_cache[workspace_path] = (now, vcs_info, whats_new)
    return vcs_info, whats_new


def _spawn_background(coro: Coroutine[Any, Any, object], name: str):
    """Spawn a fire-and-forget task with exception logging on completion.

    Retaining the task handle is not required, but a done callback surfaces
    task-internal failures instead of "exception was never retrieved" noise.
    """
    task = asyncio.create_task(coro)

    def _done(t: asyncio.Task[Any]) -> None:
        try:
            if not t.cancelled():
                t.result()
        except Exception as exc:  # noqa: BLE001 - task teardown must not raise
            logger.error('background task %s failed: %s', name, exc)

    task.add_done_callback(_done)
    return task


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
    session._last_context_snapshot = None
    # Fresh verifier gate receipts for this turn (see system_tools._updateState).
    session._verification_receipts = None
    # Auto-memories are on-demand by default; the budget-gated auto-recall
    # below injects a small recall when there is headroom. The model pulls
    # deeper past-session context via memory_search / fact_search /
    # context_read / brain_query when the user asks about prior work.
    _HEURISTIC_CAP = 15
    try:
        from app.services.memory_store import _conn as brainConn

        conn = brainConn()
        heuristicsRows = conn.execute(
            'SELECT rule, source, category, confidence FROM learned_heuristics '
            "WHERE COALESCE(suppressed, 0) = 0 "
            'ORDER BY confidence DESC, updated_at DESC LIMIT ?',
            (_HEURISTIC_CAP,),
        ).fetchall()
        if heuristicsRows:
            memory['learnedHeuristics'] = [dict(r) for r in heuristicsRows]
        totalHeuristics = conn.execute('SELECT COUNT(*) FROM learned_heuristics').fetchone()[0]
        if totalHeuristics > _HEURISTIC_CAP:
            from app.services.brain_event_bus import emitBrainEvent

            emitBrainEvent(
                category='heuristic',
                layer='workbench.prompt_injection',
                summary=f'Heuristic cap active: showing {_HEURISTIC_CAP} of {totalHeuristics} rules',
            )
    except Exception:
        logger.debug('prompt: heuristics load failed', exc_info=True)
    coreFacts = get_memory('coreMemory')
    if coreFacts:
        memory['coreMemory'] = coreFacts
    # User-authored Added Memory — inject every turn (opposite of on-demand recalled).
    try:
        from app.services.memory.auto_memory import list_user_added_memories

        added = list_user_added_memories(limit=40)
        if added:
            memory['addedMemories'] = cast(list[JsonValue], added)
    except Exception:
        logger.debug('prompt: added memories load failed', exc_info=True)
    agentContext = None
    if session.agentId:
        try:
            from app.services.tools.agent_registry import renderAgentContext

            agentContext = renderAgentContext(session.agentId)
        except Exception:
            logger.debug('prompt: agent context failed', exc_info=True)
    brainPolicy = None
    try:
        from app.services.memory.brain_orchestrator import classifyTask, extractTextFromMessages, policyForTask

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
    whatsNew = ''
    if workspacePath:
        vcsInfo, whatsNew = _probe_workspace_git(workspacePath)
    memoryStats = {}
    try:
        from app.services.memory_store import get_stats as memStats

        memoryStats = memStats()
    except Exception:
        logger.debug('prompt: memory stats failed', exc_info=True)
    skillsManifest, _skillsInner = _seg_cache.get_skills_segments()
    cognitiveBudget = None
    try:
        from app.services.workbench.token_budget import computeBudget

        provider = getattr(session, 'provider', None) or ''
        model = getattr(session, 'model', None) or ''
        providerName = provider.get('name', '') if isinstance(provider, dict) else str(provider)
        modelName = model.get('name', '') if isinstance(model, dict) else str(model)
        msgsForBudget = getattr(session, 'messages', []) or []
        # Budget against the model's real window, not a fixed default, so the
        # pressure signal and the auto-recall gate below reflect reality.
        window = _resolveModelContextWindow(
            modelName or '', provider if isinstance(provider, dict) else None
        )
        cognitiveBudget = computeBudget(
            msgsForBudget,
            model=modelName or None,
            provider=providerName or None,
            maxContext=window,
        )
    except Exception:
        logger.debug('prompt: cognitive budget failed', exc_info=True)
    # Budget-gated auto-recall: with headroom, surface the most relevant past
    # memories directly; under pressure the on-demand memory tools stay the
    # only recall path so we never push the conversation toward compaction.
    try:
        if _shouldAutoRecall(cognitiveBudget, session=session) and not memory.get('autoMemories'):
            from app.services.memory.auto_memory import getRelevantMemories

            recalled = getRelevantMemories(
                _lastUserMessageText(session), limit=5, durable_only=True
            ) or []
            if recalled:
                session._last_recalled_memories = recalled
                memory['autoMemories'] = cast(list[JsonValue], recalled)
    except Exception:
        logger.debug('prompt: auto-recall failed', exc_info=True)
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
        'verifierEnforced': bool(getattr(session, 'verifierEnforced', False)),
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
    # Content-hash key: Tier1+Tier2 are deterministic functions of these inputs.
    # When any input changes the hash changes → cache miss → rebuild. This makes
    # staleness structurally impossible (no manual invalidate needed).
    import hashlib
    import json as _json

    _hash_inputs = _json.dumps(
        [
            sessionDict.get('guardMode', ''),
            sessionDict.get('id', ''),
            sessionDict.get('capabilitiesBlock', ''),
            str(sessionDict.get('toolNames', [])),
            sessionDict.get('workspacePath', ''),
            sessionDict.get('vcs', ''),
            sessionDict.get('goal', ''),
            _json.dumps(sessionDict.get('plan'), default=str, sort_keys=True),
            sessionDict.get('planApproved', ''),
            sessionDict.get('augMd', ''),
            str(sessionDict.get('learnedHeuristics', [])),
            str(memory.get('userProfile', '') if isinstance(memory, dict) else ''),
        ],
        default=str,
        sort_keys=True,
    )
    cacheKey = hashlib.sha256(_hash_inputs.encode()).hexdigest()[:32]
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
    extraParts: list[str] = [
        _seg_cache.CLARIFY_BLOCK,
        _seg_cache.BULK_BLOCK,
        _seg_cache.WEB_BLOCK,
    ]
    # Snapshot of what this turn's prompt actually injected — carried into the
    # per-turn `done` event and the chat context panel (A5).
    try:
        recalled = getattr(session, '_last_recalled_memories', None) or []
        session._last_context_snapshot = {
            'profileSummaryUsed': bool(memory.get('userProfile')),
            'heuristicsUsed': len(as_list(memory.get('learnedHeuristics'), [])),
            'addedMemories': len(as_list(memory.get('addedMemories'), [])),
            'recalledMemories': [
                {
                    'key': as_str(m.get('key'), ''),
                    'category': as_str(m.get('category'), 'auto'),
                    'snippet': as_str(
                        m.get('description') or m.get('label') or m.get('content') or m.get('text') or '', ''
                    )[:200],
                }
                for m in recalled
                if isinstance(m, dict)
            ][:5],
            'currentContextUsed': bool(memory.get('global_context')),
            'activeProjects': len(as_list(memory.get('active_projects'), [])),
            'coreFactsUsed': bool(memory.get('coreMemory')),
            'augDirectiveUsed': bool(sessionDict.get('augMd')),
        }
    except Exception:
        logger.debug('prompt: context snapshot failed', exc_info=True)
        session._last_context_snapshot = None
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


def _shouldAutoRecall(
    cognitive_budget: dict[str, object] | None,
    min_headroom: int = 6000,
    *,
    session: object | None = None,
) -> bool:
    """Auto-recall only on a fresh session when there is prompt headroom.

    ``low``/``medium`` attention pressure plus at least ``min_headroom``
    remaining tokens keeps first-turn recall free of cost under pressure. On
    later turns the model uses memory_search/fact_search only when the user
    actually needs past context, so ordinary messages do not trigger recall.
    """
    if not cognitive_budget:
        return False
    if session is not None:
        messages = getattr(session, 'messages', None)
        if isinstance(messages, list):
            user_turns = sum(
                1 for message in messages
                if isinstance(message, dict) and message.get('role') == 'user'
            )
            if user_turns > 1:
                return False
        elif int(getattr(session, 'messageCount', 0) or 0) > 1:
            return False
    pressure = as_str(cognitive_budget.get('attention_pressure'), '')
    raw_remaining = cognitive_budget.get('remaining_tokens')
    remaining = int(raw_remaining) if isinstance(raw_remaining, (int, float)) else 0
    return pressure in ('low', 'medium') and remaining >= min_headroom


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
    if mode == 'plan':
        # Already in plan mode — the mode-switch tool has done its job.
        blocked_in_plan = {'enter_plan_mode', 'request_plan_mode'}
        tools = [t for t in tools if as_str(t.get('name')) not in blocked_in_plan]
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
    if mode == 'plan':
        blocked_in_plan = {'enter_plan_mode', 'request_plan_mode'}

        def _tool_name_plan(t: dict[str, object]) -> str:
            fn = as_dict(t.get('function'))
            return as_str(fn.get('name') or t.get('name'))

        tools = [t for t in tools if _tool_name_plan(t) not in blocked_in_plan]
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


def _verifier_gated_emit(session: object, emit):
    """Wrap a turn's emit callback with the opt-in verifier final-answer gate.

    When ``session.verifierEnforced`` is set, final-answer text (``finalOutput``
    events) is withheld until ``update_state(phase='complete')`` passes the
    verifier gate; a single ``verifierBlocked`` event is emitted instead so the
    UI can explain why the answer is withheld. All other event types
    (error/done/toolResult/thinking/…) pass through untouched, and the gate has
    zero effect when the flag is off (the default — casual chat is unaffected).
    """
    if emit is None:
        return None
    if not getattr(session, 'verifierEnforced', False):
        return emit
    _fired = {'flag': False}

    def _wrapped(evt: dict[str, object]) -> None:
        etype = as_str(evt.get('type'), '')
        if etype in ('finalOutput', 'final_output'):
            state = getattr(session, '_execution_state', None)
            phase = as_str(as_dict(state, {}).get('phase'), '') if state else ''
            if phase != 'complete':
                if not _fired['flag']:
                    _fired['flag'] = True
                    stateDict = as_dict(state, {}) if state else {}
                    # Evidence for the UI banner: what the model claimed, what
                    # it said blocks completion, and whether any verification
                    # command ran this turn (receipts).
                    receipts = as_list(getattr(session, '_verification_receipts', None), [])
                    emit(
                        {
                            'type': 'verifierBlocked',
                            'message': (
                                'Verification required: the final answer is withheld until '
                                "the model calls update_state(phase='complete') after a "
                                'passing verification run.'
                            ),
                            'evidence': {
                                'currentPhase': as_str(stateDict.get('phase'), 'research'),
                                'verificationCommand': as_str(
                                    stateDict.get('verification_command'), ''
                                ),
                                'blockers': as_list(stateDict.get('blockers'), [])[:5],
                                'completed': as_list(stateDict.get('completed'), [])[:5],
                                'receiptCount': len(receipts),
                            },
                        }
                    )
                return
        emit(evt)

    return _wrapped


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
    # Opt-in verifier enforcement: while session.verifierEnforced is set,
    # finalOutput text is withheld until update_state(phase='complete') passes
    # the verifier gate. Casual chat (flag off) is unaffected.
    emit = _verifier_gated_emit(session, emit)
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
    def _buildSystemText(session: WorkbenchSession, tools: list[dict[str, object]]) -> str:
        """Build the full system prompt for a session under its current guard mode,
        appending effort + handoff. Callers may pass tools computed under a just-
        flipped guard mode so the prompt reflects the active mode immediately."""
        text = buildSystemPrompt(session, tools=tools)
        if thinking_enabled:
            text = (
                f'{text}\n\n<effort>\n{effort_to_prompt_instruction(effectiveEffort)}\n</effort>'
            )
        else:
            text = (
                f'{text}\n\n<effort>\n'
                'Do not use extended reasoning or long chain-of-thought. '
                'Answer directly with minimal internal thinking.\n'
                '</effort>'
            )
        handoff = (handoff_summary or '').strip()
        if handoff:
            text = (
                f'{text}\n\n'
                '<model_handoff>\n'
                f'{handoff}\n'
                '</model_handoff>'
            )
        return text

    with _trace.span('prompt_build'):
        # Build tool defs once and pass into system prompt (no double conversion).
        tools = toolDefinitions(session)
        openaiTools = openaiToolDefinitions(session)
        systemText = _buildSystemText(session, tools)
        if emit and session._last_recalled_memories:
            emit(
                {
                    'type': 'recalledMemories',
                    'items': [
                        {
                            'id': str(m.get('id') or m.get('key') or ''),
                            'key': str(m.get('key') or ''),
                            'category': str(m.get('category') or 'auto'),
                            'snippet': str(m.get('description') or m.get('label') or '')[:200],
                        }
                        for m in session._last_recalled_memories
                        if isinstance(m, dict)
                    ],
                }
            )
    isAnthropic = _isAnthropicProvider(resolvedProvider)
    isOpenai = _isOpenaiProvider(resolvedProvider)

    def _isCancelled() -> bool:
        return signal is not None and signal.is_set()

    from app.lib.async_subprocess import current_subprocess_cancel

    _cancel_token = current_subprocess_cancel.set(signal)
    # Pre-initialize so the `finally` usage emit is safe even if the turn
    # aborts before the tool loop re-declares these counters.
    totalInputTokens = 0
    totalOutputTokens = 0
    finalContextTokens = 0
    # Wall time spent inside model sub-calls only (tool execution excluded) —
    # the denominator for the per-turn tokens/sec shown in the chat chip.
    totalGenerationMs = 0.0
    try:
        from app.providers.clients.base import estimateTokens
        from app.services.memory.context_compressor import compressMessages, isFeatureEnabled

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
            currentTurn = getattr(session, 'turnCount', 0)
            lastCompaction = getattr(session, '_last_compaction_turn', -100)
            turnsSinceCompaction = currentTurn - lastCompaction
            # Compress toward ~55% of the real window so the next turn has headroom.
            threshold = max(4096, int(contextWindow * 0.55))
            currentMessages = list(session.messages)
            if _shouldAutoCompact(attentionPressure, turnsSinceCompaction):
                summarizer = None
                try:
                    from app.services.cognitive_config import get_features
                    from app.services.workbench.providers import make_compactor_llm_client

                    if get_features().get('llm_compactor', False):
                        summarizer = make_compactor_llm_client(resolvedProvider, resolvedModel)
                except Exception:
                    summarizer = None
                compressed = await compressMessages(
                    currentMessages,
                    threshold=threshold,
                    head_count=4,
                    tail_count=6,
                    summarizer=summarizer,
                )
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
        retryPolicy = _modelRetryPolicy()
        for retryAttempt in range(retryPolicy['maxRetries'] + 1):
            _llmT0 = time.monotonic()
            with _trace.span('llm_wait', round=toolRound, attempt=retryAttempt):
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
            totalGenerationMs += (time.monotonic() - _llmT0) * 1000
            # Retry transient upstream failures (429 rate limits, 5xx, network)
            # instead of killing the turn — up to maxRetries, then surface the
            # error as before.
            if not _isRetryableModelError(response):
                break
            if retryAttempt >= retryPolicy['maxRetries'] or _isCancelled():
                break
            delayMs = _modelRetryDelayMs(retryAttempt + 1, response, retryPolicy)
            logger.warning(
                'workbench model call failed (retry %d/%d in %dms): %s',
                retryAttempt + 1,
                retryPolicy['maxRetries'],
                delayMs,
                as_str(response.get('error')),
            )
            if emit:
                emit(
                    {
                        'type': 'retrying',
                        'attempt': retryAttempt + 1,
                        'maxRetries': retryPolicy['maxRetries'],
                        'delayMs': delayMs,
                        'reason': as_str(response.get('error')),
                    }
                )
            await _interruptibleSleep(delayMs / 1000)
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
                if emit and (
                    stop_reason in ('max_tokens', 'length') or len(thinkingContent) > 2000
                ):
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
            if toolName in ('enter_plan_mode', 'request_plan_mode'):
                msg = enterPlanMode(session, emit=emit)
                # enterPlanMode flips the session into plan mode, but the tool
                # defs were computed at turn start under the old guard mode (full
                # access strips submit_plan). Rebuild them + the system prompt so
                # submit_plan is immediately available on the next model call of
                # this same turn instead of waiting for the next turn.
                tools = toolDefinitions(session)
                openaiTools = openaiToolDefinitions(session)
                systemText = _buildSystemText(session, tools)
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
                planPayload = _loadPlanPayload(session, toolInput)
                if planPayload is None:
                    msg = (
                        f'Plan not found. Write your plan as markdown to {plan_file_relpath(session.id)} '
                        'in the workspace (the only file you may write in plan mode), '
                        'then call submit_plan again.'
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
                submitPlan(session, planPayload)
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
                        try:
                            from app.services.rollback_store import record_rollback

                            paths = []
                            for f in as_list(ck.get('files')):
                                if isinstance(f, dict) and f.get('path'):
                                    paths.append(str(f.get('path')))
                            target = paths[0] if len(paths) == 1 else (as_str(ck.get('label')) or as_str(ck.get('id')))
                            record_rollback(
                                type='restore_file',
                                target=target,
                                before={
                                    'sessionId': session.id,
                                    'checkpointId': ck.get('id'),
                                    'paths': paths,
                                },
                                after={'toolName': toolName, 'paths': paths},
                                extra={'sessionId': session.id, 'checkpointId': ck.get('id')},
                            )
                        except Exception:
                            pass
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
                        if toolName in (
                            'web_search',
                            'WebSearch',
                            'mcp__workspace__web_search',
                            'web_fetch',
                            'WebFetch',
                            'mcp__workspace__web_fetch',
                        ):
                            # Progress events so the UI is not silent during search/fetch.
                            async def _on_web_progress(
                                phase: str, meta: dict[str, object] | None = None
                            ) -> None:
                                if not emit:
                                    return
                                # Prefer reading/read so the ToolCallCard sub-list updates
                                # (phase "running" is a UI no-op in applyToolProgress).
                                allowed = ('reading', 'read', 'running', 'done', 'error')
                                payload: dict[str, object] = {
                                    'type': 'tool_progress',
                                    'id': toolUseId,
                                    'name': toolName,
                                    'phase': phase if phase in allowed else 'running',
                                    'message': '',
                                }
                                if isinstance(meta, dict):
                                    msg = as_str(meta.get('message'), '')
                                    if not msg and phase == 'reading':
                                        msg = 'Searching / fetching…'
                                    elif not msg and phase == 'done':
                                        msg = 'Complete'
                                    payload['message'] = msg
                                    if meta.get('paths') is not None:
                                        payload['paths'] = meta.get('paths')
                                    if meta.get('path'):
                                        payload['path'] = meta.get('path')
                                    elif meta.get('url'):
                                        payload['path'] = meta.get('url')
                                emit(payload)

                            if toolName in (
                                'web_search',
                                'WebSearch',
                                'mcp__workspace__web_search',
                            ):
                                from app.services.tool_registrations.web_tools import _webSearch

                                result = await _webSearch(
                                    as_str(toolInput.get('query'), ''),
                                    maxResults=as_int(toolInput.get('maxResults'), 10),
                                    on_progress=_on_web_progress,
                                )
                            else:
                                from app.services.tool_registrations.web_tools import _webFetch

                                result = await _webFetch(
                                    as_str(toolInput.get('url'), ''),
                                    on_progress=_on_web_progress,
                                )
                        elif toolName in (
                            'run_command',
                            'bash',
                            'mcp__workspace__bash',
                        ):
                            # Stream live stdout/stderr into tool_progress.preview so
                            # the chat shows download progress while the command runs.
                            from app.lib.async_subprocess import current_command_output

                            async def _run_command_with_stream() -> str:
                                last_emit = time.monotonic()

                                async def _on_output(chunk: str) -> None:
                                    nonlocal last_emit
                                    if not emit or not chunk:
                                        return
                                    last_emit = time.monotonic()
                                    emit(
                                        {
                                            'type': 'tool_progress',
                                            'id': toolUseId,
                                            'name': toolName,
                                            'phase': 'running',
                                            'preview': chunk,
                                        }
                                    )

                                if emit:
                                    emit(
                                        {
                                            'type': 'tool_progress',
                                            'id': toolUseId,
                                            'name': toolName,
                                            'phase': 'running',
                                            'message': 'Running…',
                                        }
                                    )

                                out_token = current_command_output.set(_on_output)
                                stop = asyncio.Event()

                                async def _idle_beat() -> None:
                                    beat_count = 0
                                    while not stop.is_set():
                                        try:
                                            await asyncio.wait_for(stop.wait(), timeout=8.0)
                                            break
                                        except asyncio.TimeoutError:
                                            if not emit or stop.is_set():
                                                continue
                                            if time.monotonic() - last_emit < 7.0:
                                                continue
                                            beat_count += 1
                                            # First beat: warn about possible interactive prompt.
                                            msg = (
                                                'Command may be waiting for interactive input '
                                                '(stdin is closed — consider adding --yes / -y flags)'
                                                if beat_count == 1
                                                else 'Still working…'
                                            )
                                            emit(
                                                {
                                                    'type': 'tool_progress',
                                                    'id': toolUseId,
                                                    'name': toolName,
                                                    'phase': 'running',
                                                    'message': msg,
                                                }
                                            )

                                beat_task = asyncio.create_task(_idle_beat())
                                try:
                                    return await _executeTool(toolName, toolInput, session)
                                finally:
                                    stop.set()
                                    current_command_output.reset(out_token)
                                    beat_task.cancel()
                                    try:
                                        await beat_task
                                    except (asyncio.CancelledError, Exception):
                                        pass

                            result = await _run_command_with_stream()
                        else:
                            # Generic tool: emit start + periodic heartbeat if slow.
                            if emit:
                                emit(
                                    {
                                        'type': 'tool_progress',
                                        'id': toolUseId,
                                        'name': toolName,
                                        'phase': 'running',
                                        'message': f'Running {toolName}…',
                                    }
                                )
                            _tool_stop = asyncio.Event()

                            async def _tool_heartbeat() -> None:
                                while not _tool_stop.is_set():
                                    try:
                                        await asyncio.wait_for(_tool_stop.wait(), timeout=8.0)
                                        break
                                    except asyncio.TimeoutError:
                                        if not emit or _tool_stop.is_set():
                                            continue
                                        emit(
                                            {
                                                'type': 'tool_progress',
                                                'id': toolUseId,
                                                'name': toolName,
                                                'phase': 'running',
                                                'message': f'Still working on {toolName}…',
                                            }
                                        )

                            _hb_task = asyncio.create_task(_tool_heartbeat())
                            try:
                                result = await _executeTool(toolName, toolInput, session)
                            finally:
                                _tool_stop.set()
                                _hb_task.cancel()
                                try:
                                    await _hb_task
                                except (asyncio.CancelledError, Exception):
                                    pass
                    if isinstance(result, str) and result.startswith('Error:'):
                        tracker.record_failure(toolName)
                    if guardStatus == 'warn':
                        result = guardMsg + '\n' + result
            except Exception:
                with _trace.span('tool_exec', tool=toolName):
                    result = await _executeTool(toolName, toolInput, session)
            # Verifier gate receipt: keep the tail of command output for this turn
            # so update_state can require a real verification run before it allows
            # a review/complete transition (see system_tools._updateState).
            if 'run_command' in toolName or toolName in ('bash', 'safe_python'):
                try:
                    receipts = getattr(session, '_verification_receipts', None)
                    if receipts is None:
                        receipts = []
                        setattr(session, '_verification_receipts', receipts)
                    receipts.append({'name': toolName, 'content': as_str(result, '')[-3000:]})
                    if len(receipts) > 12:
                        del receipts[: len(receipts) - 12]
                except Exception:
                    logger.debug('verifier receipt record failed', exc_info=True)
            MAX_SSE_CONTENT = 100 * 1024
            contentTruncated = len(result) > MAX_SSE_CONTENT
            sseContent = result[:MAX_SSE_CONTENT]
            if contentTruncated:
                sseContent += '\n\n[... Tool result truncated at 100 KB — full length: {} bytes]'.format(len(result))
            if emit:
                providerSetup = None
                integrationSetup = None
                _INTEGRATION_TOOLS = {'connect_github', 'connect_slack', 'connect_google', 'install_mcp_server'}
                if toolName == 'setup_provider':
                    try:
                        parsed = json.loads(result)
                        if isinstance(parsed, dict) and parsed.get('providerId'):
                            providerSetup = parsed
                    except Exception:
                        providerSetup = None
                if toolName in _INTEGRATION_TOOLS:
                    try:
                        parsed = json.loads(result)
                        isu = parsed.get('integrationSetup') if isinstance(parsed, dict) else None
                        if isinstance(isu, dict):
                            integrationSetup = isu
                    except Exception:
                        integrationSetup = None
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
                        'integrationSetup': integrationSetup,
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
        # Monotonic turn counter — drives the auto-compaction cooldown
        # (messageCount shrinks on compaction and cannot serve this role).
        session.turnCount = getattr(session, 'turnCount', 0) + 1
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
            # Journey timeline: one entry per completed turn (last user ask).
            try:
                from app.services.memory_store.rest import write_timeline_event

                lastAsk = _lastUserMessageText(session)[:240]
                if lastAsk:
                    write_timeline_event(session.id, lastAsk, category='workbench')
            except Exception:
                logger.debug('workbench timeline write failed', exc_info=True)
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
        current_subprocess_cancel.reset(_cancel_token)
        if emit:
            # Surface this turn's token usage so the UI can render a per-turn
            # chip (early-exit `done` events above carry no usage).
            # durationMs covers model generation only (tool rounds excluded)
            # so the chip's tokens/sec reflects raw model throughput.
            doneEvent: dict[str, object] = {
                'type': 'done',
                'sessionId': sessionId,
                'usage': {
                    'inputTokens': totalInputTokens,
                    'outputTokens': totalOutputTokens,
                    'contextTokens': finalContextTokens,
                    'durationMs': int(totalGenerationMs),
                },
            }
            # Per-turn context snapshot (A5): what the harness injected into
            # this turn's prompt — the chat context panel's data feed.
            snapshot = getattr(session, '_last_context_snapshot', None)
            if isinstance(snapshot, dict):
                doneEvent['context'] = snapshot
                try:
                    from app.services.brain_write_facade import save_kv

                    save_kv(f'session_context:{sessionId}', snapshot)
                except Exception:
                    logger.debug('context snapshot persist failed', exc_info=True)
            # Proactive memory suggestions (F3): cheap deterministic preference
            # candidates from the last user message — the chat renders
            # one-click "Save as memory" chips. Only emitted when the user has
            # not already stated the same fact (profile near-dup guard).
            try:
                suggestions = _extract_memory_suggestions(session)
                if suggestions:
                    doneEvent['memorySuggestions'] = suggestions
            except Exception:
                logger.debug('memory suggestions extract failed', exc_info=True)
            emit(doneEvent)
    review_model = _backgroundTaskModel('reviewModel', resolvedModel)
    auto_memory_model = _backgroundTaskModel('autoMemoryModel', resolvedModel)
    try:
        from app.services.memory.background_review import (
            ReviewGates,
            scheduleEndOfSessionReview,
            tryBackgroundReview,
        )

        review_client = _makeReviewLlmClient(resolvedProvider, review_model)

        _spawn_background(
            tryBackgroundReview(
                session,
                list(currentMessages),
                gates=ReviewGates(turn_interval=3, tool_round_interval=6),
                llm_client=review_client,
            ),
            'background_review',
        )
        _spawn_background(
            scheduleEndOfSessionReview(
                session,
                list(currentMessages),
                llm_client=review_client,
            ),
            'end_of_session_review',
        )
    except Exception:
        pass
    # Diff learning: derive correction rules from committed git history.
    # Gated inside (feature flag + interval + git availability), so a
    # non-git workspace or off-flag is a cheap no-op.
    try:
        workspace = str(getattr(session, 'workspacePath', '') or '').strip()
        if workspace:
            from app.services.memory.diff_learning import learn_from_diffs

            _spawn_background(
                learn_from_diffs(
                    workspace,
                    llm_client=_makeReviewLlmClient(resolvedProvider, review_model),
                ),
                'diff_learning',
            )
    except Exception:
        pass
    try:
        from app.services.workbench.chat_stages import schedule_post_turn_side_effects

        schedule_post_turn_side_effects(
            session=session,
            messages=list(currentMessages),
            auto_memory_model=auto_memory_model or None,
            sync_auto_memory=_syncAutoMemory,
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
    """Auto-memory sync — extract durable todos without archiving every turn.

    Runs fire-and-forget after each workbench turn so it never delays
    the response. Explicit model ``remember`` calls and the gated background
    review own durable fact capture; this hook only keeps actionable todos.
    The ``model`` argument is retained for the scheduler callback contract."""
    from app.services.memory.auto_memory import extractAndSaveTodos
    from app.services.memory.cross_session_context import sync_from_turn

    try:
        extractAndSaveTodos(messages, session_id=str(getattr(session, 'id', '') or ''))
    except Exception:
        pass
    try:
        lastUserMsg = _lastUserMessageText(session)
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


# Deterministic preference patterns for one-click memory suggestions (F3).
# Conservative by design: full sentences with an explicit preference verb, so
# casual chat rarely triggers and genuine statements ("I prefer X over Y")
# become saveable facts without an extra LLM call per turn.
_MEMORY_SUGGESTION_PATTERNS = [
    re.compile(r'\b(?:I|we)\s+(?:prefer|use|like|love|hate|dislike|need|want|avoid)\s+(.{8,120})', re.IGNORECASE),
    re.compile(r'\b(?:My|our)\s+(?:name|role|stack|team|company|project|tool)\s+(?:is|are)\s+(.{3,120})', re.IGNORECASE),
    re.compile(r'\b(?:I|we)\s+work(?:ing)?\s+on\s+(.{8,120})', re.IGNORECASE),
]


def _extract_memory_suggestions(session: WorkbenchSession) -> list[str]:
    """Candidate "save as memory" facts from the last user message.

    Near-dup guard against facts already in the user profile, and a
    per-session seen-set so the same statement is not re-suggested on every
    turn. Returns up to 3 clean candidates; empty when nothing qualifies.
    """
    import re as _re

    text = _lastUserMessageText(session)
    if not text.strip():
        return []
    seen = getattr(session, '_memory_suggestions_seen', None)
    if seen is None:
        seen = set()
        setattr(session, '_memory_suggestions_seen', seen)
    # Existing profile facts (near-dup guard)
    known: list[str] = []
    try:
        from app.services.memory_store import get_memory

        profile = get_memory('userProfile')
        if isinstance(profile, dict):
            for f in as_list(profile.get('facts'), []):
                d = as_dict(f)
                if d:
                    known.append(as_str(d.get('fact'), '').lower())
    except Exception:
        pass
    candidates: list[str] = []
    for pattern in _MEMORY_SUGGESTION_PATTERNS:
        for m in pattern.finditer(text):
            cand = _re.sub(r'\s+', ' ', m.group(1)).strip(' .,;:!?')
            if not (8 <= len(cand) <= 120):
                continue
            low = cand.lower()
            if any(low in k or k in low for k in known):
                continue
            if low in seen:
                continue
            seen.add(low)
            candidates.append(cand)
            if len(candidates) >= 3:
                return candidates
    return candidates


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

        # Lifecycle hooks: PRE_TOOL_USE (can deny or modify)
        try:
            from app.services.hooks import HookContext, HookEvent
            from app.services.hooks import registry as hook_registry

            pre_ctx = HookContext(
                event=HookEvent.PRE_TOOL_USE,
                session_id=session.id,
                tool_name=toolName,
                tool_args=args,
                workspace_path=getattr(session, 'workspacePath', None),
            )
            pre_results = await hook_registry.emit(HookEvent.PRE_TOOL_USE, pre_ctx)
            for r in pre_results:
                if r.action == 'deny':
                    return f'[BLOCKED by hook] {r.message or "Tool call denied by policy."}'
                if r.action == 'modify' and r.modified_args is not None:
                    args = r.modified_args
        except Exception:
            pass  # Hooks must never break tool execution

        result = await dispatchTool(toolName, args)
        result_str = str(result)

        # Lifecycle hooks: POST_TOOL_USE (can modify result)
        try:
            from app.services.hooks import HookContext as HC2
            from app.services.hooks import HookEvent as HE2
            from app.services.hooks import registry as hr2

            post_ctx = HC2(
                event=HE2.POST_TOOL_USE,
                session_id=session.id,
                tool_name=toolName,
                tool_args=args,
                tool_result=result_str,
                workspace_path=getattr(session, 'workspacePath', None),
            )
            post_results = await hr2.emit(HE2.POST_TOOL_USE, post_ctx)
            for r in post_results:
                if r.action == 'modify' and r.modified_result is not None:
                    result_str = r.modified_result
        except Exception:
            pass  # Hooks must never break tool execution

        try:
            from app.services.post_observation import capture_after_tool

            await capture_after_tool(toolName, result_str)
        except Exception:
            pass
        return result_str
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
    In ask/edit mode, creates a pending mutation for the ApprovalBanner UI.
    Full Access never creates permission prompts — including for ``run_command``.
    """
    mode = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')

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

    # Full Access: never queue Ask/Edit permission banners (including run_command).
    if mode == 'full':
        return None

    if mode == 'plan' and (not session.planApproved) and is_mutating(toolName, args):
        if is_plan_file_write(session, toolName, args):
            # The plan markdown is the only file writable in plan mode.
            return None
        return (
            f"Tool '{toolName}' is destructive and cannot run in plan mode. "
            f'The only file you may write is the plan itself ({plan_file_relpath(session.id)}). '
            'Finish investigating with non-destructive tools, write the plan to that '
            'file, call `submit_plan`, and wait for the user to approve before executing.'
        )
    # Edit automatically: file edits proceed; shell/commands still need approval.
    if mode == 'edit' and is_shell_mutation(toolName, args):
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
    if mode == 'ask' and isPlanModeBlocked(toolName, args):
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
    _emitSessionStatus(session.id)


def enterPlanMode(session: WorkbenchSession, emit: object | None = None) -> str:
    """Switch a session into plan mode (model-initiated via enter_plan_mode).

    Only ever makes the session MORE restrictive: destructive tools stay
    blocked until the user approves a plan. Leaving plan mode remains
    user-controlled (plan approval or a manual mode switch).
    """
    mode_now = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')
    if mode_now == 'plan':
        return (
            'Already in Plan mode. Investigate with non-destructive tools, write your '
            f'plan to {plan_file_relpath(session.id)}, then call submit_plan and wait for approval.'
        )
    session.guardMode = 'plan'
    session.agentId = 'plan'
    session.updatedAt = _now()
    # Prompt cache is content-hash keyed — guardMode change alters the hash
    # automatically; no manual invalidation needed.
    try:
        from app.services.workbench.sessions import save_sessions

        save_sessions()
    except Exception:
        pass
    _emitSessionStatus(session.id)
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=session.id, guardMode='plan', agentId='plan')
        emit_invalidate('workbench-session', 'session-status', session_id=session.id)
    except Exception:
        pass
    if callable(emit):
        emit({'type': 'guardModeChanged', 'guardMode': 'plan', 'agentId': 'plan'})
    return (
        'Plan mode enabled — destructive tools are now blocked. Investigate with '
        f'read-only tools, write your plan as markdown to {plan_file_relpath(session.id)} (the '
        'only file you may write), then call submit_plan and wait for the user to approve.'
    )


_MAX_PLAN_BYTES = 200_000


def _loadPlanPayload(
    session: WorkbenchSession, toolInput: dict[str, object]
) -> dict[str, object] | None:
    """Resolve the plan payload for submit_plan.

    Preference: explicit ``planPath`` argument (only honored when it points
    at this session's own plan file — plans are session-private) → the
    session plan file (``.aug/plans/<sessionId>.md``) → legacy inline
    ``plan``/``steps`` payload. The file's content becomes ``plan.markdown``,
    which the plan drawer renders as-is. Returns None when nothing usable was
    found so the caller can tell the model to write the plan file first.
    """
    import os
    from pathlib import Path

    workspace = as_str(getattr(session, 'workspacePath', None) or '').strip()
    own = plan_file_path(workspace, as_str(getattr(session, 'id', None) or ''))
    rawPath = as_str(toolInput.get('planPath') or toolInput.get('path'))
    target: str | None = None
    if rawPath and workspace and own:
        candidate = rawPath if os.path.isabs(rawPath) else os.path.join(workspace, rawPath)
        # Session-scoped: only this session's own plan file is readable.
        # Any other path (another session's plan, arbitrary workspace file)
        # is ignored so plans never leak across sessions.
        try:
            if os.path.normcase(os.path.normpath(candidate)) == os.path.normcase(own):
                target = candidate
        except Exception:
            target = None
    if not target:
        target = own
    if target and os.path.isfile(target):
        try:
            content = Path(target).read_text('utf-8', errors='replace')[:_MAX_PLAN_BYTES]
        except Exception:
            content = ''
        if content.strip():
            rel = os.path.relpath(target, workspace) if workspace else target
            return {'markdown': content, 'planPath': rel.replace(os.sep, '/')}
    inline = toolInput.get('plan') or toolInput.get('steps')
    if inline:
        return inline if isinstance(inline, dict) else {'plan': inline}
    return None


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
                if q.get('multiSelect'):
                    item['multiSelect'] = True
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
    """Store a todo list on the session."""
    if not isinstance(todosData, list):
        todosData = [todosData] if todosData else []
    session.todos = todosData
    session.updatedAt = _now()
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
                try:
                    from app.services.rollback_store import record_rollback

                    paths = []
                    for f in as_list(ck.get('files')):
                        if isinstance(f, dict) and f.get('path'):
                            paths.append(str(f.get('path')))
                    target = paths[0] if len(paths) == 1 else (as_str(ck.get('label')) or as_str(ck.get('id')))
                    record_rollback(
                        type='restore_file',
                        target=target,
                        before={
                            'sessionId': session.id,
                            'checkpointId': ck.get('id'),
                            'paths': paths,
                        },
                        after={'toolName': tool_name, 'paths': paths},
                        extra={'sessionId': session.id, 'checkpointId': ck.get('id')},
                    )
                except Exception:
                    pass
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
