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
import os
import random
import re
import time
import uuid
from typing import Any, Callable, Coroutine, cast

from app.json_narrowing import as_bool, as_dict, as_float, as_int, as_list, as_str
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
from app.services.workbench.validator import validationErrorText
from app.type_aliases import JsonValue

logger = logging.getLogger('workbench')
# Default tool-round cap (25). brain-orchestrator maxWorkbenchToolLoops can
# raise/lower it at runtime via config (Settings → Brain) — the effective cap
# is resolved per turn in _managedToolLoopCap. The stall detector below stops
# loops that spin without making progress even before the cap.
MAX_MANAGED_TOOL_ROUNDS = 25
# Recurring-task / daemon sub-agents run unbounded today (they bypass the
# orchestrator's worker pool). Cap concurrent runs so a burst of due tasks
# cannot spawn an arbitrary number of model calls at once.
MAX_RECURRING_SUBAGENT_CONCURRENCY = 3
_recurringSubagentSlots = asyncio.Semaphore(MAX_RECURRING_SUBAGENT_CONCURRENCY)
# Stall detection: if the session's execution phase/step has not advanced for
# this many consecutive rounds (and the turn is already deep), stop and ask
# the model to reflect instead of letting it spin on repeated tool calls.
MAX_STALLED_ROUNDS = 8
MIN_ROUNDS_BEFORE_STALL_CHECK = 12
# Code-mode (fenced python) execution cap.
_CODE_RUN_TIMEOUT_S = 60
# Tool dispatch cap: a hung MCP server or registry handler must not hold a
# turn (and a sub-agent semaphore slot) forever. Env-overridable.
_TOOL_EXEC_TIMEOUT_S = max(30, int(os.environ.get('AUGUST_TOOL_TIMEOUT_S', '300')))
# Clean rounds on the bare surface before the full tool set is restored
# (reversible downgrade — A6).
_DOWNGRADE_RECOVERY_ROUNDS = 3
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
# Quota/billing failures are NOT transient — retrying only repeats the failed
# attempt and burns budget (audit fix). OpenAI uses 402; gateways commonly
# report 429 with a quota marker.
_QUOTA_STATUSES = {402}
# NOTE: deliberately no bare 'billing' marker — August's own generic hint
# ("Check API key, billing/credits...") appears in empty-response errors that
# MUST stay retryable.
_QUOTA_MARKERS = (
    'quota',
    'insufficient_quota',
    'payment required',
    'exceeded your current',
)

# ── Tool progress beats (generic tools + run_command idle warning) ──
# Extracted to constants so eval tests can shrink the windows instead of
# waiting real seconds.

_TOOL_HEARTBEAT_INTERVAL_S = 8.0
_COMMAND_IDLE_BEAT_INTERVAL_S = 8.0
_COMMAND_IDLE_BEAT_MIN_GAP_S = 7.0

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
    # An empty mid-turn response is usually a swallowed upstream failure
    # (context overflow 400, gateway hiccup) — retrying costs one call and
    # often recovers; hard-failing strands the whole turn (weak-model win).
    'empty response',
)


def _isRetryableModelError(response: dict[str, object]) -> bool:
    """True when a failed model sub-call is worth retrying (429/5xx/network).

    Quota/billing failures are never retried: 402, or any message carrying a
    quota marker, even on a 429 status.
    """
    if not response.get('error'):
        return False
    status = response.get('errorStatus')
    if isinstance(status, int) and status in _QUOTA_STATUSES:
        return False
    msg = as_str(response.get('error')).lower()
    if any((m in msg for m in _QUOTA_MARKERS)):
        return False
    if isinstance(status, int) and status in _MODEL_RETRY_STATUSES:
        return True
    return any((marker in msg for marker in _MODEL_RETRY_MARKERS))


# Auto-recall probe verbs: messages that reach into the past should trigger
# mid-conversation recall ("what did I say about X", "do you remember…").
_PROBES_PAST_RE = re.compile(
    r"\b(remember|recall|what did i (?:say|tell|ask)|last (?:time|week|month|session|chat)|"
    r"earlier|before|previously|previous (?:chat|session)|"
    r"(?:my )?(?:preference|setting|habit|goal)s?|"
    r"do you (?:remember|know) (?:me|about)|who am i|about me)\b",
    re.IGNORECASE,
)

# Refusal patterns: a model claiming it cannot use tools despite being
# offered them (or hosted on a gateway that silently drops `tools`). Narrow
# by design — "as an AI" prose must not false-positive.
_REFUSAL_RE = re.compile(
    r"((?:i|we) (?:can't|cannot|am|are) (?:unable to|not able to|not allowed to) (?:use|run|execute|access) tools?"
    r"|(?:i|we) (?:don't|do not|can't|cannot) (?:have|get) (?:access to|to use) tools?"
    r"|no tools? (?:are )?available"
    r"|tool (?:use|access|usage) (?:is|isn't|is not) (?:not )?(?:available|enabled|supported)"
    r"|i have no tools?)",
    re.IGNORECASE,
)


def _isToolRefusal(text: str) -> bool:
    """True when the assistant text reads as a tool-use refusal."""
    return bool(_REFUSAL_RE.search(text or ''))


# Text tool protocol: models that ignore native `tools` (or gateways that
# silently drop them) call tools via `[TOOLCALL] name|json` lines — one per
# line, mirroring smolagents text-protocol patterns.
_TEXT_TOOLCALL_RE = re.compile(
    r'^\[TOOLCALL\]\s+([A-Za-z0-9_.-]+)\s*\|\s*(.*)$', re.IGNORECASE | re.MULTILINE
)


def _parseTextToolCalls(text: str) -> list[tuple[str, dict[str, object]]]:
    """Parse ``[TOOLCALL] name|json`` protocol lines into (name, args) pairs."""
    calls: list[tuple[str, dict[str, object]]] = []
    if not text:
        return calls
    for m in _TEXT_TOOLCALL_RE.finditer(text):
        name = m.group(1)
        raw = m.group(2).strip()
        from app.services.workbench.json_salvage import salvage_json_object

        saved = salvage_json_object(raw) if raw else {}
        if saved is not None:
            calls.append((name, saved))
        else:
            # Unsalvageable garbage must never execute as {} — mark it so the
            # loop's validation path surfaces an error (mirrors the native
            # tool-call _raw handling; audit finding).
            calls.append((name, {'_raw': raw}))
    return calls


def _stripTextToolCallLines(text: str) -> str:
    """Remove protocol lines from assistant text before it enters history."""
    lines = [
        ln for ln in (text or '').splitlines() if not _TEXT_TOOLCALL_RE.match(ln.strip())
    ]
    return '\n'.join(lines).strip()


def _setAssistantText(
    assistantMsg: dict[str, object],
    text: str,
    isAnthropic: bool,
    contentBlocks: list[dict[str, object]] | None = None,
) -> None:
    """Replace the assistant message's text payload (both wire formats)."""
    if isAnthropic and contentBlocks is not None:
        for b in contentBlocks:
            if isinstance(b, dict) and as_str(b.get('type'), '') == 'text':
                b['text'] = text
        assistantMsg['content'] = cast(JsonValue, contentBlocks)
    else:
        assistantMsg['content'] = text


def _memoryChangeNotice(
    toolName: str, toolInput: dict[str, object], result: object
) -> str:
    """Friendly one-liner for a memory tool result (in-chat notice)."""
    text = as_str(result, '')
    try:
        if toolName == 'remember':
            content = as_str(toolInput.get('content'), '')
            return f'Remembered: {content[:140]}' if content else 'Saved a memory.'
        if toolName == 'update_memory':
            content = as_str(toolInput.get('content'), '')
            return f'Updated a memory: {content[:140]}' if content else 'Updated a memory.'
        if toolName == 'forget':
            mid = as_int(toolInput.get('memoryId'), 0)
            return f'Forgot a memory (id {mid}).' if mid else 'Forgot a memory.'
        if toolName == 'update_heuristics':
            return 'Updated a learned rule.'
    except Exception:
        pass
    return text[:140]


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


_CONTEXT_OVERFLOW_MARKERS = (
    'context length',
    'context window',
    'maximum context',
    'context_length',
    'context_window',
    'too many tokens',
    'token limit',
    'max_tokens',
    'prompt is too long',
    'input is too long',
)


def _isContextOverflowError(response: dict[str, object]) -> bool:
    """True when the failure is a context-window overflow (promotable)."""
    msg = as_str(response.get('error')).lower()
    return any((marker in msg for marker in _CONTEXT_OVERFLOW_MARKERS))


def _chatFallbackChain() -> list[str]:
    """Configured fallback chain (fleet ``chat_chain``, comma-separated ids)."""
    try:
        from app.services.model_fleet_service import getModelForRole

        raw = getModelForRole('chat_chain')
        return [m.strip() for m in raw.split(',') if m.strip()]
    except Exception:
        return []


def _chatContextPromotionModel() -> str:
    """Configured larger-context sibling (fleet ``chat_context_promotion``)."""
    try:
        from app.services.model_fleet_service import getModelForRole

        return getModelForRole('chat_context_promotion').strip()
    except Exception:
        return ''


def _managedToolLoopCap() -> int:
    """Effective tool-round cap for this turn.

    brain-orchestrator ``maxWorkbenchToolLoops`` (Settings → Brain) overrides
    the hardcoded default of 25; 0 disables the cap entirely.
    """
    try:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = getRuntimeConfig()
        if 'maxWorkbenchToolLoops' in cfg and cfg.get('maxWorkbenchToolLoops') is not None:
            value = as_int(cfg.get('maxWorkbenchToolLoops'), 0)
            if value >= 0:
                return value
    except Exception:
        logger.debug('maxWorkbenchToolLoops read failed; using default', exc_info=True)
    # Absent key → the documented default (25). The old shape
    # (``as_int(..., 0)`` + ``>= 0``) made the hardcoded constant dead — the
    # seeded config always carried 100, so "defaults to 25" was never true.
    return MAX_MANAGED_TOOL_ROUNDS


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
_GIT_PROBE_CACHE_MAX = 128  # evict stale entries when exceeded


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
    # Evict stale entries when cache grows too large.
    if len(_git_probe_cache) > _GIT_PROBE_CACHE_MAX:
        expired = [k for k, v in _git_probe_cache.items() if now - v[0] >= _GIT_PROBE_TTL_S]
        for k in expired[:len(expired) // 2 or 1]:
            _git_probe_cache.pop(k, None)
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


def _modelDisplayName(modelId: str) -> str:
    """Friendly model name for the prompt identity (e.g. 'Claude Sonnet 4.5')."""
    raw = (modelId or '').strip()
    if not raw:
        return 'the selected model'
    for prefix in ('models/', 'openai/', 'anthropic/', 'azure/', 'openrouter/', 'gemini/'):
        if raw.lower().startswith(prefix):
            raw = raw[len(prefix):]
    raw = raw.split('@')[0].split(':')[0]
    tokens = [tok for tok in re.split(r'[-_.]+', raw) if tok]
    out: list[str] = []
    digits: list[str] = []
    for tok in tokens:
        if tok.isdigit() and len(tok) == 8:
            continue  # date-stamped snapshot ids
        if tok.isdigit():
            digits.append(tok)
            continue
        if digits:
            out.append('.'.join(digits))
            digits = []
        out.append(tok.upper() if tok.lower() in ('gpt', 'llm', 'ai') else tok.capitalize())
    if digits:
        out.append('.'.join(digits))
    return ' '.join(out).strip() or 'the selected model'


_HARNESS_SKILL_NAMES = ('august-harness', 'august-tools')
_harness_guide_cache: dict[str, str] = {}
_caps_block_cache: dict[str, str] = {}


def _harness_guide_text() -> str:
    """Inlined bodies of the two built-in harness skills (memoized)."""
    if 'text' not in _harness_guide_cache:
        try:
            from app.services import skill_service

            _harness_guide_cache['text'] = skill_service.load_bodies(
                list(_HARNESS_SKILL_NAMES)
            )
        except Exception:
            logger.debug('prompt: harness skills load failed', exc_info=True)
            _harness_guide_cache['text'] = ''
    return _harness_guide_cache['text']


def buildSystemPrompt(
    session: WorkbenchSession,
    tools: list[dict[str, object]] | None = None,
) -> str:
    """Assemble the lean system prompt for a workbench session.

    Single-pass build with no memory recall, no heuristics and no skill
    relevance scoring: core operating rules, the two harness skills
    inlined, workspace context (VCS + AUG.md), live session state and the
    tool protocol. Expensive pieces (git probe, skill bodies, capabilities
    block) are memoized so a turn never pays for them twice.
    """
    from app.services.harness_mode import is_benchmark_mode
    from app.services.workbench import prompt_segments_cache as _seg_cache

    session._last_recalled_memories = None
    session._last_context_snapshot = None
    is_worker = int(getattr(session, 'subagent_depth', 0) or 0) > 0
    is_benchmark = is_benchmark_mode(session)

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

    workspacePath = (
        str(session.workspacePath)
        if hasattr(session, 'workspacePath') and session.workspacePath
        else ''
    )
    vcsInfo = ''
    if workspacePath:
        vcsInfo, _whatsNew = _probe_workspace_git(workspacePath)
    augMdBody = ''
    if workspacePath:
        try:
            from app.services import aug_directive_service

            loaded = aug_directive_service.load(workspacePath)
            if loaded and loaded.get('body'):
                augMdBody = as_str(loaded.get('body', ''))
        except Exception:
            logger.debug('prompt: AUG.md load failed', exc_info=True)

    # Identity = the model the user actually picked, not a product persona.
    modelName = _modelDisplayName(as_str(getattr(session, 'model', ''), ''))
    parts: list[str] = [
        '<core>\n'
        f"You are {modelName}, a coding agent on the user's machine.\n"
        'Rules:\n'
        '- Lead with the outcome; be concise; never narrate tool use — emit the call.\n'
        '- Read before writing; pass the read sha256 as fileHash on writes/edits.\n'
        '- Batch independent calls; run_command is non-interactive; its exit code is your receipt.\n'
        '- Track multi-step work with update_state '
        '(research | plan | implement | review | complete); finish on complete.\n'
        '- Never invent file contents or command output.\n'
        '</core>'
    ]
    if not is_worker and not is_benchmark:
        guide = _harness_guide_text()
        if guide:
            parts.append(f'<harness_guide>\n{guide}\n</harness_guide>')
    if workspacePath:
        ws = ['<workspace>', f'path: {workspacePath}']
        if vcsInfo:
            ws.append(f'vcs: {vcsInfo}')
        ws.append('</workspace>')
        parts.append('\n'.join(ws))
        if augMdBody:
            parts.append(f'<aug_directives>\n{augMdBody}\n</aug_directives>')
    agentMode = as_str(getattr(session, 'agent_mode', '') or '')
    sessionBlock = [
        '<session>',
        f"id: {getattr(session, 'id', '') or ''}",
        f"title: {getattr(session, 'title', '') or ''}",
    ]
    if session.goal:
        sessionBlock.append(f'goal: {session.goal}')
    if session.plan:
        sessionBlock.append(f'plan: {json.dumps(session.plan, default=str)}')
    if session.plan:
        sessionBlock.append('plan status: ' + ('approved' if session.planApproved else 'pending'))
    sessionBlock.append(
        'guardMode: ' + normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')
    )
    if agentMode:
        sessionBlock.append(f'agentMode: {agentMode}')
    if getattr(session, 'verifierEnforced', False):
        sessionBlock.append(
            'verifier: ON — the final answer is withheld until '
            "update_state(phase='complete') passes verification."
        )
    execState = getattr(session, '_execution_state', None)
    if execState:
        sessionBlock.append(f'execution_state: {json.dumps(execState, default=str)}')
    working = getattr(session, '_working_memory', None)
    if working:
        sessionBlock.append(
            f'scratchpad: {working if isinstance(working, str) else json.dumps(working, default=str)}'
        )
    failure = getattr(session, '_failure_feedback', None)
    if failure:
        sessionBlock.append(
            f'last_tool_failure: {failure if isinstance(failure, str) else json.dumps(failure, default=str)}'
        )
    if session.todos:
        sessionBlock.append(f'todos: {json.dumps(session.todos, default=str)}')
    sessionBlock.append('</session>')
    parts.append('\n'.join(sessionBlock))
    if session.agentId:
        try:
            from app.services.tools.agent_registry import renderAgentContext

            agentContext = renderAgentContext(session.agentId)
            if agentContext:
                parts.append(f'<agent>\n{agentContext}\n</agent>')
        except Exception:
            logger.debug('prompt: agent context failed', exc_info=True)
    if not is_benchmark and tool_names:
        capsKey = '\n'.join(sorted(tool_names))
        caps = _caps_block_cache.get(capsKey)
        if caps is None:
            try:
                from app.services.capabilities_prompt import build_capabilities_block

                caps = build_capabilities_block(tool_names)
            except Exception:
                logger.debug('prompt: capabilities block failed', exc_info=True)
                caps = ''
            _caps_block_cache[capsKey] = caps
        if caps:
            parts.append(f'<capabilities>\n{caps}\n</capabilities>')
    # Conditional policy blocks: only when the matching tools are offered.
    # CLARIFY stays unconditional — submit_clarify is intercepted by the turn
    # loop, not registered, so the model only learns it from this block.
    offeredTools = set(tool_names)
    parts.append(_seg_cache.CLARIFY_BLOCK)
    if offeredTools & {
        'bulk',
        'read_files',
        'write_files',
        'delete_sessions',
        'rename_sessions',
        'kill_daemons',
        'web_fetch_many',
        'load_skills',
    }:
        parts.append(_seg_cache.BULK_BLOCK)
    if offeredTools & {'web_search', 'web_fetch'}:
        parts.append(_seg_cache.WEB_BLOCK)
    return '\n\n'.join(p for p in parts if p)


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


def _shouldAutoCompact(
    attention_pressure: str,
    turns_since_compaction: int,
    remaining_tokens: int | None = None,
) -> bool:
    """Auto-compact at high (≥80%) or critical (≥90%) pressure after a short cooldown.

    Cooldown avoids re-compacting every turn once we are near the window.
    When remaining tokens are provided, also triggers if headroom is very low.
    """
    if remaining_tokens is not None and remaining_tokens < 8000:
        return True
    return attention_pressure in ('high', 'critical') and turns_since_compaction >= 2


def _msgTextLower(msg: dict[str, object]) -> str:
    """Lowercased text of a workbench message (string or text blocks)."""
    content = msg.get('content', '')
    if isinstance(content, str):
        return content.lower()
    if isinstance(content, list):
        parts: list[str] = []
        for b in content:
            if isinstance(b, dict) and b.get('type') in ('text', 'output_text'):
                parts.append(str(b.get('text', '')))
        return '\n'.join(parts).lower()
    return ''


def _is_update_state_transition(msg: dict[str, object]) -> bool:
    """Landmark (P4): an update_state tool call or its 'State updated' receipt.

    The phase/step the model last recorded is key state — a middle-summary
    must not drop it.
    """
    role = msg.get('role', '')
    if role == 'tool':
        lower = _msgTextLower(msg)
        return 'state updated' in lower and 'phase=' in lower
    if role == 'assistant':
        content = msg.get('content', '')
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name') == 'update_state':
                    return True
        for tc in as_list(msg.get('tool_calls'), []):
            if isinstance(tc, dict):
                fn = as_dict(tc.get('function'), {})
                if as_str(fn.get('name'), '') == 'update_state':
                    return True
    return False


def _is_failing_receipt(msg: dict[str, object]) -> bool:
    """Landmark (P4): a tool result showing a failing run (test/lint/build).

    The latest failure output is exactly what the model needs to fix the
    task — a 120-char summary line can drop the actual error string.
    """
    if msg.get('role') != 'tool':
        return False
    lower = _msgTextLower(msg)
    if 'failed' in lower or 'error:' in lower:
        return True
    return bool(re.search(r'exit code:\s*[1-9]\d*', lower))


# ── Auto-applied capability profiles (A5, opt-in AUGUST_AUTO_PROFILE=1) ──
# The suggestion loop is two-way (downgrades + upgrades); auto-apply closes
# it into an experiment: the profile is written to the provider store, the
# before-rates are recorded, and once enough new traces accumulate the
# experiment is evaluated — worse rates → revert, held/improved → confirm.


def _session_cost_usd(session: object) -> float:
    """Estimate a session's cumulative spend (USD) from its token totals.

    Delegates to the shared cost_estimator (per-model pricing table + env
    overrides, cache-aware) — the same source the usage endpoint uses, so
    the composer chip, the spend ceiling, and the Usage page agree.
    """
    from app.services.cost_estimator import session_cost_usd

    return session_cost_usd(
        model_id=as_str(getattr(session, 'model', ''), ''),
        total_in=as_int(getattr(session, 'totalInputTokens', 0), 0),
        total_out=as_int(getattr(session, 'totalOutputTokens', 0), 0),
        cache_hit=as_int(getattr(session, 'cacheHitTokens', 0), 0),
        cache_miss=as_int(getattr(session, 'cacheMissTokens', 0), 0),
    )


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
        # Cache-stability + truncation priority (P7/L5): the bare-essential
        # tools sort FIRST in a stable order, so (a) a self-heal downgrade to
        # the bare surface yields a PREFIX of the full list — the Anthropic
        # prompt-cache breakpoint on the tools array stays valid when a
        # struggling model is downgraded — and (b) maxTools truncation cuts
        # non-essential tools first instead of by registry position.
        tools.sort(
            key=lambda t: (0 if as_str(t.get('name'), '') in _BARE_TOOL_ALLOW else 1, as_str(t.get('name'), ''))
        )
        return tools

    tools = tool_defs_cache.get_or_build('anthropic', _build_base)
    try:
        from app.services.tools.model_tools import assembleToolDefs

        messages = getattr(session, 'messages', None) or []
        contextMsgs = list(messages) if isinstance(messages, list) else []
        # Budget the tool set against the session model's REAL window — a
        # 32k model must not be offered the same tool budget as a 200k one.
        contextWindow = 128000
        try:
            modelId = as_str(getattr(session, 'model', ''), '')
            provider = as_dict(getattr(session, 'provider', None), {})
            if modelId:
                contextWindow = _resolveModelContextWindow(modelId, provider or None)
        except Exception:
            logger.debug('tool-defs context window resolve failed', exc_info=True)
        result = assembleToolDefs(
            all_tool_defs=tools, context_messages=contextMsgs, contextLength=contextWindow
        )
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
    return _finalize_session_tools(session, tools)


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
        'write_scratchpad',
        'diagnose_proxy',
    }
)


def _toolDefName(t: dict[str, object]) -> str:
    """Extract a tool definition's name (Anthropic or OpenAI shape)."""
    fn = as_dict(t.get('function'), {})
    return as_str(t.get('name') or fn.get('name'), '')


def _modelCapabilityProfile(session: WorkbenchSession) -> dict[str, object]:
    """Per-model tool profile from the provider config (never raises)."""
    modelId = as_str(getattr(session, 'model', '') or '')
    providerName = as_str(getattr(session, 'provider', '') or '')
    if not modelId:
        return {}
    try:
        from app.services import config_service

        for p in config_service.getProvidersAsModels():
            if p.name != providerName and p.id != providerName:
                continue
            for m in p.models:
                if m.id == modelId:
                    return {
                        'tool_surface': m.tool_surface or 'full',
                        'max_tools': int(m.max_tools or 0),
                        'max_tool_result_chars': int(m.max_tool_result_chars or 0),
                    }
    except Exception:
        pass
    return {}


def _finalize_session_tools(
    session: WorkbenchSession, tools: list[dict[str, object]]
) -> list[dict[str, object]]:
    tools = _applyModelCapabilityProfile(session, tools)
    from app.services.harness_mode import (
        filter_benchmark_tools,
        filter_planner_tools,
        is_benchmark_mode,
        is_orchestrator_mode,
    )

    if is_orchestrator_mode(session):
        return filter_planner_tools(tools)
    if is_benchmark_mode(session):
        return filter_benchmark_tools(session, tools)
    return tools


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


def _toolResultCap(session: WorkbenchSession) -> int:
    """Per-model tool-result truncation cap (falls back to the harness default)."""
    profile = _modelCapabilityProfile(session)
    cap = as_int(profile.get('max_tool_result_chars'), 0)
    return cap if cap > 0 else MAX_TOOL_RESULT_CHARS


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
        # Same bare-first stable ordering as the Anthropic builder (P7/L5).
        tools.sort(
            key=lambda t: (0 if _toolDefName(t) in _BARE_TOOL_ALLOW else 1, _toolDefName(t))
        )
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
    return _finalize_session_tools(session, tools)


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
    # FIFO for every kind: steers/subagent completions get PRIORITY as a
    # group in the drain formatter (steer → subagent → queue), but within a
    # group the user's order must hold — front-inserting here made three
    # steers drain as 3,2,1 (both to the model and to the injected bubbles).
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
    sessionId: str,
    emit: Callable[[dict[str, object]], None] | None = None,
    kinds: set[str] | None = None,
) -> list[dict[str, object]]:
    """Pop queued messages and return them in FIFO order.

    When ``kinds`` is given, only entries whose ``kind`` is in the set are
    popped — the rest stay queued for a later drain (auto-turn consumers
    must never consume a user's own queued message).

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
    if kinds:
        popped: list[dict[str, object]] = []
        kept: list[dict[str, object]] = []
        for entry in entries:
            if str(entry.get('kind') or 'queue').lower() in kinds:
                popped.append(entry)
            else:
                kept.append(entry)
        if not popped:
            return []
        session.queuedUserMessages = kept
        entries = popped
    else:
        session.queuedUserMessages = []
    session.updatedAt = _now()
    saveSessions()
    if emit is not None:
        try:
            from app.services import event_log

            for entry in entries:
                # Emit on the LIVE stream too — the frontend renders each
                # queued message as an inline user bubble via the
                # user_message_injected SSE event (audit finding: entries
                # were only appended to the event log, never emitted).
                emit(
                    {
                        'type': 'userMessageInjected',
                        'sessionId': sessionId,
                        'messageId': entry.get('id', ''),
                        'text': entry.get('text', ''),
                        'queuedAt': entry.get('queuedAt', ''),
                    }
                )
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


async def _runFencedCodeBlock(session: WorkbenchSession, text: str, toolRound: int) -> str | None:
    """Execute the model's fenced ```python block in code mode.

    Extracts the last fenced block, prepends the workspace-bound tool API,
    writes it under ``<workspace>/.aug/code_runs/`` and runs it through the
    existing sandboxed ``run_command`` machinery (same policy / approvals as
    any shell command). Returns None when the text has no fenced block.
    """
    try:
        from app.services.workbench.code_runner import (
            build_runner_source,
            extract_fenced_python,
            format_result,
            runner_command,
            runner_path,
        )

        block = extract_fenced_python(text)
        if block is None:
            return None
        ws = as_str(getattr(session, 'workspacePath', '') or '')
        _run_dir, path = runner_path(ws, session.id, toolRound)
        with open(path, 'w', encoding='utf-8') as f:
            # The session's sandbox mode is rendered into the runner preamble
            # (read-only denies write_file/run_command inside the child).
            f.write(
                build_runner_source(
                    block,
                    ws,
                    sandbox_mode=as_str(getattr(session, 'sandboxMode', '') or ''),
                )
            )
        result = await _executeTool(
            'run_command',
            {'command': runner_command(path), 'timeout': _CODE_RUN_TIMEOUT_S},
            session,
        )
        return format_result(result)
    except Exception as exc:
        logger.debug('code-mode run failed', exc_info=True)
        return f'Error running code block: {exc}'


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
    try:
        from app.services.harness_ops import touch_activity

        touch_activity()
    except Exception:
        pass
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
            forceRelease = bool(getattr(session, '_verifier_force_release_this_turn', False))
            state = getattr(session, '_execution_state', None)
            phase = as_str(as_dict(state, {}).get('phase'), '') if state else ''
            if phase != 'complete' and not forceRelease:
                if not _fired['flag']:
                    _fired['flag'] = True
                    # Live flags for the turn: the refusal re-prompt guard
                    # reads _verifier_blocked; routing evidence reads
                    # _verifier_blocked_this_turn (withheld ≠ win).
                    setattr(session, '_verifier_blocked', True)
                    setattr(session, '_verifier_blocked_this_turn', True)
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
            if forceRelease:
                emit(
                    {
                        'type': 'warning',
                        'message': (
                            'Verifier gate auto-released: the model ignored the verification '
                            'steer twice — showing the answer without a passing verification run.'
                        ),
                    }
                )
                # Consume the one-shot release: it applies to the NEXT turn
                # after two ignored steers, then resets (a fresh user turn
                # must not inherit a stale release).
                setattr(session, '_verifier_force_release', False)
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
    # The model the user picked always wins — no fleet/role override.
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
    # Recurring-task daemon (B7): fire due reminders at turn start — surfaced
    # to the UI as recurringTask SSE events → notification bell. Tasks may
    # carry an `[agent:ID model:MODEL]` directive: the reminder ALSO dispatches
    # a sub-agent with that agent + model on schedule.
    try:
        from app.services.recurring_tasks import check_and_fire, parse_agent_directive

        workspace = as_str(getattr(session, 'workspacePath', '') or '')
        for taskMsg, taskModel in check_and_fire(sessionId, workspace):
            cleanMsg, agentId, modelOverride = parse_agent_directive(taskMsg)
            # The task's pinned model (structured field) fills in when the
            # text directive does not name one.
            if not modelOverride and taskModel:
                modelOverride = taskModel
            if emit:
                emit({'type': 'recurringTask', 'message': cleanMsg[:2000]})
            if agentId:
                try:
                    from app.services.workbench.subagent import executeSubAgent

                    async def _run_recurring_subagent() -> None:
                        # Cap concurrent recurring sub-agents (they bypass the
                        # orchestrator worker pool) so a burst of due tasks
                        # cannot spawn unbounded model calls at once.
                        try:
                            async with _recurringSubagentSlots:
                                result = await executeSubAgent(
                                    session,
                                    agentId,
                                    cleanMsg[:2000] or f'Recurring task ({agentId})',
                                    emit=emit,
                                    model_override=modelOverride or '',
                                )
                        except Exception:
                            logger.debug('recurring-task subagent failed', exc_info=True)
                            return
                        try:
                            if not result or as_str(result.get('status')) in ('failed', 'error', 'blocked'):
                                return
                            # The parent model must see the outcome — enqueue
                            # the completion notice like the spawn tool does
                            # (kind='subagent' also triggers the auto-turn if
                            # this turn has already ended).
                            from app.services.tools.spawn_subagents_tool import _enqueue_completion

                            _enqueue_completion(session, result)
                        except Exception:
                            logger.debug('recurring-task subagent enqueue failed', exc_info=True)

                    asyncio.create_task(_run_recurring_subagent())
                except Exception:
                    logger.debug('recurring-task subagent dispatch failed', exc_info=True)
    except Exception:
        logger.debug('recurring tasks check failed', exc_info=True)
    # Turn-scoped verifier/self-heal state (audit sweep): everything below is
    # reset here — at the TRUE turn start — instead of inside
    # buildSystemPrompt, so a mid-turn prompt rebuild (enter_plan_mode) can't
    # wipe verifier receipts, and stale flags/counters can't leak across turns.
    setattr(session, '_verifier_blocked', False)
    setattr(session, '_verifier_blocked_this_turn', False)
    setattr(session, '_refusal_count', 0)
    setattr(session, '_verification_receipts', None)
    # The force-release flag is set by the PREVIOUS turn's finally (A7, after
    # two ignored verifier steers) — snapshot it for THIS turn only, then clear
    # the raw flag so a later unrelated turn can never inherit a stale release.
    setattr(
        session, '_verifier_force_release_this_turn', bool(getattr(session, '_verifier_force_release', False))
    )
    setattr(session, '_verifier_force_release', False)
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
        agentMode = as_str(getattr(session, 'agent_mode', '') or '')
        if getattr(session, '_text_tool_protocol', False):
            text = (
                f'{text}\n\n<tool_protocol>\n'
                'Native tool calls are DISABLED for this model. To use a tool, write a '
                'line exactly like:\n'
                '[TOOLCALL] tool_name|{"arg": "value"}\n'
                'One tool call per line. The harness executes it and returns the result '
                'as a tool message. Do not describe tool calls in prose.\n'
                # Few-shot exemplars (R6): concrete correct lines for the two
                # most common tools — a downgraded weak model often needs to
                # SEE the shape, not just be told it.
                'Examples:\n'
                '[TOOLCALL] read_file|{"path": "src/main.py"}\n'
                '[TOOLCALL] run_command|{"command": "pytest -q"}\n'
                '</tool_protocol>'
            )
        if agentMode == 'code':
            text = (
                f'{text}\n\n<agent_mode>\n'
                'You are in CODE MODE. Do NOT call tools. Instead, write a single fenced '
                '```python block that solves the task using these workspace-bound functions:\n'
                '- read_file(path) → file contents\n'
                '- write_file(path, content) → "ok"\n'
                '- run_command(cmd, timeout=30) → "Exit code: N\\nstdout\\nstderr"\n'
                '- list_files(path=".") → newline-separated paths\n'
                'The block runs in a sandbox inside the workspace. Print your final '
                'answer (or assign it to a variable named `result`).\n'
                '</agent_mode>'
            )
        elif agentMode == 'chat':
            text = (
                f'{text}\n\n<agent_mode>\n'
                'You are in CHAT MODE: answer in text only. Tool calls are blocked.\n'
                '</agent_mode>'
            )
        elif agentMode in ('orchestrator', 'planner'):
            text = (
                f'{text}\n\n<agent_mode>\n'
                'You are in ORCHESTRATOR MODE: decide and dispatch. Do not edit files or '
                'run shell commands. Spawn named workstreams via spawn_subagents; workers '
                'act. Use list_workstreams / send_subagent_message / interrupt_subagent to '
                'steer. Switch set_agent_mode(mode="agent") to act in this session.\n'
                '</agent_mode>'
            )
        elif agentMode == 'benchmark':
            text = (
                f'{text}\n\n<agent_mode>\n'
                'You are in BENCHMARK MODE: minimal tool surface for raw capability evaluation. '
                'Use run_command and edit_lines to solve the task. No extra scaffolding.\n'
                '</agent_mode>'
            )
        return text

    with _trace.span('prompt_build'):
        # Build tool defs once and pass into system prompt (no double conversion).
        tools = toolDefinitions(session)
        openaiTools = openaiToolDefinitions(session)
        systemText = _buildSystemText(session, tools)
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
    # Universal prompt-cache metrics (Anthropic cache_read/cache_creation vs
    # OpenAI-compatible prompt_cache_hit/miss) — surfaced in the context
    # ring so cache hit rate is visible per session.
    totalCacheHitTokens = 0
    totalCacheMissTokens = 0
    # D8: which model actually answered when a fallback/promotion switch
    # happened — surfaced in the done event as usedFallback.
    chainUsedAt: str | None = None
    try:
        from app.providers.clients.base import estimateTokens
        from app.services.workbench.context_compressor import compressMessages, isFeatureEnabled

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
            remainingTokens = max(0, contextWindow - originalTokens)
            # Compress toward ~55% of the real window so the next turn has headroom.
            threshold = max(4096, int(contextWindow * 0.55))
            currentMessages = list(session.messages)
            if _shouldAutoCompact(attentionPressure, turnsSinceCompaction, remainingTokens):
                try:
                    from app.services.transcript_archive import archive_messages

                    archive_messages(sessionId, currentMessages, reason='auto-compact')
                except Exception:
                    logger.debug('transcript archive failed', exc_info=True)
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
                    # Landmark pins (P4): the latest update_state transition
                    # and failing verification receipts survive the middle
                    # summary verbatim — a summary can drop the only mention
                    # of a phase/step or an error string the model still needs.
                    pin_predicates=[_is_update_state_transition, _is_failing_receipt],
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
    # Context pressure event (context UX): one emit per turn so the UI can
    # show a live server-accurate meter / "compact now" affordance. Cheap —
    # token estimation is cached-ish and this is one SSE event per turn.
    if emit:
        try:
            from app.services.workbench.token_budget import computeBudget as _computeBudget

            _budget = _computeBudget(
                session.messages,
                model=resolvedModel,
                provider=as_str(resolvedProvider.get('name') or resolvedProvider.get('id'), '') if resolvedProvider else '',
                maxContext=_resolveModelContextWindow(resolvedModel, resolvedProvider),
                api_mode=(
                    as_str(resolvedProvider.get('apiMode') or resolvedProvider.get('apiFormat'), '')
                    if resolvedProvider
                    else ''
                ),
            )
            if isinstance(_budget, dict):
                turnBudget = _budget
                _cHit = as_int(getattr(session, 'cacheHitTokens', 0), 0)
                _cMiss = as_int(getattr(session, 'cacheMissTokens', 0), 0)
                emit(
                    {
                        'type': 'contextPressure',
                        'contextUsedPct': _budget.get('context_used_pct'),
                        'attentionPressure': _budget.get('attention_pressure'),
                        'totalTokens': _budget.get('total_tokens'),
                        'maxContext': _budget.get('max_context'),
                        'remainingTokens': _budget.get('remaining_tokens'),
                        'promptCache': {
                            'hitTokens': _cHit,
                            'missTokens': _cMiss,
                            'hitRate': round(_cHit / (_cHit + _cMiss), 3) if (_cHit + _cMiss) else 0.0,
                        },
                    }
                )
        except Exception:
            logger.debug('contextPressure emit failed (non-fatal)', exc_info=True)
    toolRound = 0
    lastExecSig: tuple[str, int] | None = None
    stalledRounds = 0
    stallMessageSent = False
    _ = turnBudget  # assigned earlier by the contextPressure pass (mypy: keep alive)
    # Turn-scoped malformed-tool counter: accumulates ACROSS rounds (a reset
    # per round meant repeated malformed calls never triggered the downgrade).
    parseFailures = 0
    # Reversible surface downgrade (A6): the bare-surface fallback restores
    # itself after a few clean rounds — one burst of malformed calls must not
    # cripple the rest of the turn (web_search/browser may still be needed).
    surfaceDowngraded = False
    cleanRoundsSinceDowngrade = 0
    # Set when the turn ends on an error path — the done-event block below
    # still runs (to flush usage/evidence), and routing evidence must record
    # ok=False for error turns, not a hardcoded win.
    turnError: str | None = None
    managedToolLoopCap = _managedToolLoopCap()
    # Trace-store bookkeeping: tool names dispatched this turn + self-heal
    # counters (recorded with the turn trace for replay/drift analysis).
    calledTools: set[str] = set()
    # Spend ceiling gate: when a per-session ceiling is set and the estimated
    # cumulative cost already meets it, block the turn BEFORE any model call
    # (the user must raise the ceiling or start a new chat).
    ceiling = as_float(getattr(session, 'costCeiling', 0.0), 0.0)
    if ceiling > 0:
        try:
            estCost = _session_cost_usd(session)
            if estCost >= ceiling:
                msg = (
                    f'Session cost ceiling reached (${estCost:.2f} ≥ ${ceiling:.2f}) — '
                    'raise the ceiling or start a new chat to continue.'
                )
                logger.warning('workbench %s', msg)
                if emit:
                    emit({'type': 'error', 'message': msg})
                turnError = turnError or msg
                try:
                    if hasattr(session, '_tool_tracker') and session._tool_tracker:
                        session._tool_tracker.record_text_response()
                except Exception:
                    pass
                # Terminal-event protocol: the finally below emits the done
                # event, but the post-loop persist block is skipped on this
                # early return — reset the streaming status so the sidebar
                # doesn't show a permanently "generating" chat (audit finding).
                session.status = 'idle'
                session.updatedAt = _now()
                try:
                    saveSessions()
                except Exception:
                    logger.exception('workbench save_sessions failed after ceiling block')
                _emitSessionStatus(sessionId)
                return
        except Exception:
            logger.debug('cost ceiling check failed', exc_info=True)
    while True:
        toolRound += 1
        if managedToolLoopCap > 0 and toolRound > managedToolLoopCap:
            msg = (
                f'Tool loop exceeded maxWorkbenchToolLoops ({managedToolLoopCap}); '
                'stopping to avoid unbounded cost.'
            )
            logger.warning('workbench %s', msg)
            if emit:
                emit({'type': 'error', 'message': msg})
            turnError = turnError or msg
            break
        # Stall detection: a turn that never advances phase/step is a weak
        # model spinning on repeated tool calls. Inject a reflection prompt
        # (the model answers on the next round); hard-stop if it ignores it.
        if toolRound >= MIN_ROUNDS_BEFORE_STALL_CHECK:
            try:
                est = as_dict(getattr(session, '_execution_state', None), {})
                sig = (as_str(est.get('phase'), ''), as_int(est.get('step'), 0))
            except Exception:
                sig = None
            if sig is not None:
                if sig != lastExecSig:
                    lastExecSig = sig
                    stalledRounds = 0
                    # A phase/step advance resets the warning too — a SECOND
                    # distinct stall streak deserves its own nudge (audit
                    # finding: stallMessageSent was never reset, so the first
                    # nudge suppressed all later warnings until hard-stop).
                    stallMessageSent = False
                else:
                    stalledRounds += 1
                    if stalledRounds >= MAX_STALLED_ROUNDS and not stallMessageSent:
                        stallMessageSent = True
                        currentMessages.append(
                            {
                                'role': 'user',
                                'content': (
                                    f'[Proxy Self-Heal] {stalledRounds} tool rounds have elapsed without '
                                    'advancing your execution phase/step. Reflect on what is blocking '
                                    'you, record where you are with update_state(phase=..., step=...), '
                                    'then either take a different approach or finish with a final answer.'
                                ),
                            }
                        )
                        if emit:
                            emit(
                                {
                                    'type': 'warning',
                                    'message': 'No progress across many tool rounds — nudged the model to reflect.',
                                }
                            )
                    elif stallMessageSent and stalledRounds >= MAX_STALLED_ROUNDS + 2:
                        msg = 'Stopped: the model did not recover after the stall warning.'
                        logger.warning('workbench %s', msg)
                        if emit:
                            emit({'type': 'error', 'message': msg})
                        turnError = turnError or msg
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
        # Fallback chain + context promotion (surpass #3): after retries are
        # exhausted on the primary model, the turn continues on the next
        # configured chain model (or a larger-context sibling on overflow).
        chainModels = _chatFallbackChain()
        promotionModel = _chatContextPromotionModel()
        promotionUsed = False
        for chainIndex in range(len(chainModels) + 1):
            if chainIndex > 0:
                nextModel = chainModels[chainIndex - 1]
                nProvider, nModel = _resolveChatLlm(model=nextModel)
                if not nProvider or not nModel:
                    continue
                resolvedProvider, resolvedModel = nProvider, nModel
                # The chain model may live on a different-format provider
                # (e.g. a Zen-style entry serving claude via /v1/messages and
                # gpt via /chat/completions) — the wire format must follow the
                # provider, not the turn's first model.
                isAnthropic = _isAnthropicProvider(resolvedProvider)
                isOpenai = _isOpenaiProvider(resolvedProvider)
                chainUsedAt = resolvedModel
                logger.warning('workbench falling back to chain model %s', resolvedModel)
                if emit:
                    emit(
                        {
                            'type': 'retrying',
                            'attempt': 1,
                            'maxRetries': retryPolicy['maxRetries'],
                            'delayMs': 0,
                            'reason': f'Primary model failed — continuing on {resolvedModel}',
                        }
                    )
            response: dict[str, object] = {}
            for retryAttempt in range(retryPolicy['maxRetries'] + 1):
                _llmT0 = time.monotonic()
                # Stream text live: per-delta finalOutput/thinking events go
                # straight to the SSE log so the UI paints incrementally.
                # A retry rolls the partial attempt back via the `retrying`
                # event (the frontend clears its streaming buffer on it), so
                # a failed attempt cannot leave duplicate/garbled answers.
                # Non-text events (toolResult, warnings) pass through live too.

                def _attemptEmit(evt: dict[str, object]) -> None:
                    if emit is not None:
                        emit(evt)

                with _trace.span('llm_wait', round=toolRound, attempt=retryAttempt):
                    try:
                        from app.services.hooks.lifecycle import emit_lifecycle
                        from app.services.hooks.types import HookEvent as _HookEvent

                        _pre = await emit_lifecycle(
                            _HookEvent.PRE_MODEL_CALL,
                            sessionId,
                            extra={'round': toolRound, 'attempt': retryAttempt},
                        )
                        _deny = next((r for r in _pre if r.action == 'deny'), None)
                        if _deny is not None:
                            response = {'error': _deny.message or 'PRE_MODEL_CALL denied'}
                            break
                    except Exception:
                        logger.debug('PRE_MODEL_CALL hook failed (non-fatal)', exc_info=True)
                    if isAnthropic:
                        response = await _callAnthropicWorkbench(
                            currentMessages,
                            systemText,
                            resolvedModel,
                            tools,
                            effectiveEffort,
                            provider=resolvedProvider,
                            emit=_attemptEmit,
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
                            emit=_attemptEmit,
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
            if not response.get('error'):
                break
            if _isCancelled():
                break
            # Context promotion: overflow → larger-context sibling once,
            # before walking the normal fallback chain.
            if not promotionUsed and promotionModel and _isContextOverflowError(response):
                promotionUsed = True
                pProvider, pModel = _resolveChatLlm(model=promotionModel)
                if pProvider and pModel:
                    resolvedProvider, resolvedModel = pProvider, pModel
                    # Same wire-format caveat as the fallback chain: the
                    # promoted model may be served on a different format.
                    isAnthropic = _isAnthropicProvider(resolvedProvider)
                    isOpenai = _isOpenaiProvider(resolvedProvider)
                    chainUsedAt = resolvedModel
                    logger.warning('workbench context overflow — promoting to %s', resolvedModel)
                    if emit:
                        emit(
                            {
                                'type': 'retrying',
                                'attempt': 1,
                                'maxRetries': retryPolicy['maxRetries'],
                                'delayMs': 0,
                                'reason': f'Context overflow — promoted to {resolvedModel}',
                            }
                        )
                    continue
            if chainIndex >= len(chainModels):
                break
        if not isAnthropic and not isOpenai:
            if emit:
                emit({'type': 'error', 'message': f'Unknown provider format for {resolvedProvider}'})
            turnError = turnError or f'Unknown provider format for {resolvedProvider}'
            break
        if response.get('error'):
            if toolRound > 1:
                logger.warning(
                    'workbench model re-call failed after tool round %d: %s', toolRound - 1, response['error']
                )
            if emit:
                emit({'type': 'error', 'message': response['error']})
            turnError = turnError or as_str(response['error'])
            break
        if response.get('stream_rule'):
            # Stream rule fired mid-generation (the model narrated a tool call
            # instead of emitting one) — inject a reminder and retry from this
            # point instead of wasting the round.
            ruleName = as_str(response.get('stream_rule'))
            if emit:
                emit(
                    {
                        'type': 'warning',
                        'message': (
                            f'The model began narrating a tool call instead of emitting it '
                            f'({ruleName}) — nudging it to call tools directly.'
                        ),
                    }
                )
            currentMessages.append(
                {
                    'role': 'user',
                    'content': (
                        '[Proxy Self-Heal] Stop narrating tool calls in prose. When you need a '
                        'tool, emit it as an actual tool call; do not describe it in text. '
                        'Continue with the task.'
                    ),
                }
            )
            continue
        respUsage = as_dict(response.get('usage'), {})
        if respUsage:
            totalInputTokens += as_int(respUsage.get('input_tokens', 0))
            totalOutputTokens += as_int(respUsage.get('output_tokens', 0))
            finalContextTokens = as_int(respUsage.get('input_tokens', 0))
            # Universal cache split: Anthropic reports
            # cache_read/cache_creation_input_tokens (uncached input is the
            # miss); OpenAI-compatible reports prompt_cache_hit/miss_tokens.
            hitRaw = respUsage.get('cache_read_input_tokens')
            if hitRaw is None:
                hitRaw = respUsage.get('prompt_cache_hit_tokens')
            missRaw = respUsage.get('prompt_cache_miss_tokens')
            if missRaw is None:
                missRaw = as_int(respUsage.get('input_tokens'), 0) + as_int(
                    respUsage.get('cache_creation_input_tokens'), 0
                )
            totalCacheHitTokens += as_int(hitRaw, 0)
            totalCacheMissTokens += as_int(missRaw, 0)
        if isAnthropic:
            assistantMsg: dict[str, object] = {'role': 'assistant', 'content': response.get('content', [])}
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
                'content': cast('object', choiceMsg.get('content', '')),
                'tool_calls': cast('object', choiceMsg.get('tool_calls', [])),
            }
            textContent = as_str(response.get('text', ''))
            thinkingContent = as_str(response.get('thinking', '')) or as_str(
                choiceMsg.get('reasoning_content') or choiceMsg.get('reasoning'), ''
            )
            from app.adapters.reasoning_policy import attach_openai_reasoning

            attach_openai_reasoning(assistantMsg, thinkingContent)
            toolUses = cast('list[dict[str, object]]', as_list(response.get('tool_uses', []), []))
        if not toolUses:
            # Text tool protocol (toolSurface='text' or refusal auto-downgrade):
            # the model calls tools via `[TOOLCALL] name|json` lines instead of
            # native tool calls — parse them and fall through to the standard
            # tool processing path below.
            if getattr(session, '_text_tool_protocol', False) and textContent:
                textCalls = _parseTextToolCalls(textContent)
                if textCalls:
                    cleaned = _stripTextToolCallLines(textContent)
                    _setAssistantText(
                        assistantMsg,
                        cleaned,
                        isAnthropic,
                        contentBlocks if isAnthropic else None,
                    )
                    toolUses = [
                        {
                            'type': 'tool_use',
                            'id': f'text_{i}',
                            'name': name,
                            'input': args,
                        }
                        for i, (name, args) in enumerate(textCalls)
                    ]
        if not toolUses:
            # Code mode (smolagents CodeAgent lesson): the model wrote a fenced
            # ```python block instead of native tool calls — execute it with
            # the workspace-bound tool API and feed the output back.
            if getattr(session, 'agent_mode', '') == 'code' and textContent:
                codeResult = await _runFencedCodeBlock(session, textContent, toolRound)
                if codeResult is not None:
                    currentMessages.append(assistantMsg)
                    currentMessages.append(
                        {'role': 'tool', 'tool_use_id': f'code_{toolRound}', 'content': codeResult}
                    )
                    if emit:
                        emit(
                            {
                                'type': 'toolResult',
                                'id': f'code_{toolRound}',
                                'name': 'code_run',
                                'content': codeResult[:4000],
                                'status': 'done',
                            }
                        )
                    continue
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
            # Refusal detection: a model claiming it cannot use tools (or
            # hosted on a gateway that silently drops `tools`) would end the
            # turn with the refusal as its final answer — re-prompt once with
            # a reminder, then accept on the third refusal.
            if (
                textContent
                and _isToolRefusal(textContent)
                and getattr(session, 'agent_mode', '') != 'chat'
                and not getattr(session, '_verifier_blocked', False)
            ):
                refusalCount = as_int(getattr(session, '_refusal_count', 0), 0) + 1
                setattr(session, '_refusal_count', refusalCount)
                if refusalCount <= 2:
                    if refusalCount == 2:
                        # Second refusal: switch the model to the text tool
                        # protocol so it can keep working via [TOOLCALL] lines.
                        setattr(session, '_text_tool_protocol', True)
                    reminder = (
                        '[Proxy Self-Heal] Tool use IS available in this environment — '
                        'tools are enabled and offered to you. Do not claim you cannot '
                        'use them. Emit an actual tool call for the next step, or answer '
                        'directly in text if the task needs no tools.'
                    )
                    if refusalCount == 2:
                        reminder += (
                            '\n\n[Tool Protocol] Native tool calls are disabled for this model. '
                            'To use a tool, write a line exactly like:\n'
                            '[TOOLCALL] tool_name|{"arg": "value"}\n'
                            'One tool call per line. The harness executes it and returns the '
                            'result as a tool message.'
                        )
                    currentMessages.append({'role': 'user', 'content': reminder})
                    if emit:
                        emit(
                            {
                                'type': 'warning',
                                'message': (
                                    f'Model refused tool use (attempt {refusalCount}) — '
                                    're-prompting with a reminder.'
                                ),
                            }
                        )
                    continue
                logger.warning(
                    'workbench model refused tool use %d times; accepting the text answer',
                    refusalCount,
                )
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
        invalidThisRound = 0
        for tu in toolUses:
            if _isCancelled():
                break
            toolName = as_str(tu.get('name', ''))
            toolInput = as_dict(tu.get('input', {}))
            toolUseId = as_str(tu.get('id', f'toolu_{uuid.uuid4().hex[:16]}'))
            if toolName:
                calledTools.add(toolName)
            # Chat mode: tool calls are blocked — the model answers in text only.
            if getattr(session, 'agent_mode', '') == 'chat':
                msg = '[Blocked] Chat mode: tool calls are disabled. Answer in text only.'
                if emit:
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': msg,
                            'status': 'done',
                            'durationMs': 0,
                            'startedAtMs': int(time.time() * 1000),
                            'blocked': True,
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': msg})
                continue
            from app.services.harness_mode import (
                BENCHMARK_ALLOWED_TOOLS,
                BENCHMARK_VERIFIER_EXTRA,
                PLANNER_ALLOWED_TOOLS,
                benchmark_block_message,
                is_benchmark_mode,
                is_orchestrator_mode,
                planner_block_message,
            )

            if is_orchestrator_mode(session) and toolName and toolName not in PLANNER_ALLOWED_TOOLS:
                msg = planner_block_message(toolName)
                if emit:
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': msg,
                            'status': 'done',
                            'durationMs': 0,
                            'startedAtMs': int(time.time() * 1000),
                            'blocked': True,
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': msg})
                continue
            if is_benchmark_mode(session) and toolName:
                allowed_bench = set(BENCHMARK_ALLOWED_TOOLS)
                if getattr(session, 'verifierEnforced', False):
                    allowed_bench |= BENCHMARK_VERIFIER_EXTRA
                if toolName not in allowed_bench:
                    msg = benchmark_block_message(toolName)
                    if emit:
                        emit(
                            {
                                'type': 'toolResult',
                                'id': toolUseId,
                                'name': toolName,
                                'content': msg,
                                'status': 'done',
                                'durationMs': 0,
                                'startedAtMs': int(time.time() * 1000),
                                'blocked': True,
                            }
                        )
                    toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': msg})
                    continue
            # Tool-call recovery (surpass): malformed JSON arguments must never
            # execute as an empty dict — the model would silently do the wrong
            # thing. The OpenAI path marks failures `_invalid_json`; the
            # Anthropic stream aggregator marks them `_raw`. Surface a
            # validation-error tool result so the loop self-heals, and after
            # repeated failures send a hard nudge (weak models drift).
            invalidRaw = as_str(toolInput.get('_invalid_json') or toolInput.get('_raw'), '')
            if invalidRaw:
                parseFailures += 1
                invalidThisRound += 1
                if parseFailures >= 3 and emit and not is_benchmark_mode(session):
                    emit(
                        {
                            'type': 'warning',
                            'message': (
                                f'Tool arguments failed to parse {parseFailures} times in a row — '
                                'the model is improvising JSON instead of using the tool schema. '
                                'Consider set_agent_mode(mode="code") to write fenced python instead.'
                            ),
                        }
                    )
                msg = validationErrorText(toolName, invalidRaw[:500], malformed=True)
                if emit:
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': msg,
                            'status': 'done',
                            'durationMs': 0,
                            'startedAtMs': int(time.time() * 1000),
                            'blocked': True,
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': msg})
                continue
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
                            'durationMs': 0,
                            'startedAtMs': int(time.time() * 1000),
                            'blocked': True,
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': f'[Blocked] {blockedReason}'})
                continue
            pending_regular.append((toolName, toolInput, toolUseId))
        # A user Stop mid-round leaves the round's tool calls without results —
        # the assistant message must not be persisted with dangling calls
        # (strict gateways reject tool_use/tool_calls that lack results).
        cancelledMidRound = _isCancelled()
        # Regular tools: chat_stages runs them in parallel when all are read-only.
        from app.services.workbench.chat_stages import run_regular_tools_stage

        async def _run_regular(toolName: str, toolInput: dict[str, object], toolUseId: str) -> dict[str, object]:
            tool_started_at = int(time.time() * 1000)
            t0 = time.perf_counter()
            if emit:
                emit(
                    {
                        'type': 'toolCall',
                        'id': toolUseId,
                        'name': toolName,
                        'input': toolInput,
                        'status': 'running',
                        'startedAtMs': tool_started_at,
                    }
                )
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
            result: str | None = None
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
                                            await asyncio.wait_for(stop.wait(), timeout=_COMMAND_IDLE_BEAT_INTERVAL_S)
                                            break
                                        except asyncio.TimeoutError:
                                            if not emit or stop.is_set():
                                                continue
                                            if time.monotonic() - last_emit < _COMMAND_IDLE_BEAT_MIN_GAP_S:
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
                                    return await _executeTool(toolName, toolInput, session, toolUseId)
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
                                        await asyncio.wait_for(_tool_stop.wait(), timeout=_TOOL_HEARTBEAT_INTERVAL_S)
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
                                result = await _executeTool(toolName, toolInput, session, toolUseId)
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
                # Never re-dispatch a tool that may have already executed —
                # a partial apply followed by an unrelated tracker/emit
                # exception would run mutating tools TWICE (audit finding).
                # Only the "never started" case (result unset) retries once.
                if result is None:
                    with _trace.span('tool_exec', tool=toolName):
                        result = await _executeTool(toolName, toolInput, session, toolUseId)
                else:
                    logger.debug('tool %s raised after dispatch; not re-running', toolName, exc_info=True)
            # Verifier gate receipt: keep the tail of command output for this turn
            # so update_state can require a real verification run before it allows
            # a review/complete transition (see system_tools._updateState). The
            # command itself is recorded so the gate can match the DECLARED
            # verification_command instead of accepting any passing command.
            if 'run_command' in toolName or toolName in ('bash', 'safe_python'):
                try:
                    receipts = getattr(session, '_verification_receipts', None)
                    if receipts is None:
                        receipts = []
                        setattr(session, '_verification_receipts', receipts)
                    receipts.append(
                        {
                            'name': toolName,
                            'command': as_str(toolInput.get('command'), ''),
                            'content': as_str(result, '')[-3000:],
                        }
                    )
                    if len(receipts) > 12:
                        del receipts[: len(receipts) - 12]
                    cmd = as_str(toolInput.get('command'), '')
                    out = as_str(result, '')
                    exit_m = re.search(r'exit code:\s*(-?\d+)', out, re.IGNORECASE)
                    session.metadata = dict(getattr(session, 'metadata', None) or {})
                    session.metadata['lastCommand'] = {
                        'name': toolName,
                        'command': cmd[:200],
                        'exitCode': int(exit_m.group(1)) if exit_m else None,
                    }
                except Exception:
                    logger.debug('verifier receipt record failed', exc_info=True)
            MAX_SSE_CONTENT = 100 * 1024
            contentTruncated = len(result) > MAX_SSE_CONTENT
            if contentTruncated:
                # JSON-aware truncation: cut at a newline or a JSON boundary
                # (last ',' or '}') so the model receives a parseable fragment
                # instead of a token cut mid-string.
                cut = result[:MAX_SSE_CONTENT]
                boundary = max(cut.rfind('\n'), cut.rfind('\r'))
                if boundary <= MAX_SSE_CONTENT // 2:
                    for ch in (',', '}'):
                        idx = cut.rfind(ch)
                        if idx > MAX_SSE_CONTENT // 2:
                            boundary = idx
                            break
                sseContent = cut[:boundary] if boundary > 0 else cut
                sseContent += '\n\n[... Tool result truncated at 100 KB — full length: {} bytes]'.format(len(result))
            else:
                sseContent = result
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
                # In-chat memory notice: when the model changed long-term
                # memory, tell the user what August now remembers/forgot.
                _MEMORY_TOOLS = ('remember', 'update_memory', 'forget', 'update_heuristics')
                if toolName in _MEMORY_TOOLS:
                    try:
                        notice = _memoryChangeNotice(toolName, toolInput, result)
                        if notice:
                            emit({'type': 'memoryUpdated', 'action': toolName, 'summary': notice})
                    except Exception:
                        logger.debug('memory notice emit failed', exc_info=True)
                tool_duration_ms = int(max(0.0, (time.perf_counter() - t0) * 1000))
                emit(
                    {
                        'type': 'toolResult',
                        'id': toolUseId,
                        'name': toolName,
                        'content': sseContent,
                        'contentTruncated': contentTruncated,
                        'contentFullLength': len(result),
                        'summary': str(result)[:2000],
                        # Authoritative status: failures begin with "Error:" —
                        # the UI maps this to the red/error tool card.
                        'status': 'error' if str(result).startswith('Error:') else 'done',
                        'durationMs': tool_duration_ms,
                        'startedAtMs': tool_started_at,
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
            # The cap is per-model when the capability profile sets one.
            historyContent = result
            resultCap = _toolResultCap(session)
            if len(historyContent) > resultCap:
                # JSON-aware cut (same boundary logic as the SSE copy above):
                # a mid-token cut would hand the model a broken JSON payload
                # on the next round (audit finding).
                cut = historyContent[:resultCap]
                boundary = max(cut.rfind('\n'), cut.rfind('\r'))
                if boundary <= resultCap // 2:
                    for ch in (',', '}'):
                        idx = cut.rfind(ch)
                        if idx > resultCap // 2:
                            boundary = idx
                            break
                trimmed = cut[:boundary] if boundary > 0 else cut
                historyContent = (
                    trimmed
                    + f'\n\n[... Tool result truncated at {resultCap // 1024} KB '
                    f'— full length: {len(result)} bytes]'
                )
            return {'tool_use_id': toolUseId, 'role': 'tool', 'content': historyContent}

        try:
            toolResults.extend(
                await run_regular_tools_stage(
                    pending_regular,
                    _run_regular,
                    is_cancelled=_isCancelled,
                )
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Defensive: a tool-stage failure must never masquerade as a
            # clean turn in routing evidence — record it honestly.
            logger.warning('regular tool stage failed: %s', exc, exc_info=True)
            turnError = turnError or f'tool stage failed: {exc}'
            if emit:
                emit({'type': 'error', 'message': f'Tool stage failed: {exc}'})
            break
        # The model recovered: valid arguments this round reset the turn-scoped
        # malformed counter (it accumulates only across consecutive bad rounds).
        if invalidThisRound == 0:
            parseFailures = 0
            if surfaceDowngraded:
                cleanRoundsSinceDowngrade += 1
                # Restore the full surface after a few clean rounds on the
                # bare set (reversible downgrade — A6).
                if cleanRoundsSinceDowngrade >= _DOWNGRADE_RECOVERY_ROUNDS:
                    tools = toolDefinitions(session)
                    openaiTools = openaiToolDefinitions(session)
                    surfaceDowngraded = False
                    cleanRoundsSinceDowngrade = 0
                    if emit:
                        emit(
                            {
                                'type': 'warning',
                                'message': (
                                    'Tool surface restored to full — the model recovered from '
                                    'malformed tool calls.'
                                ),
                            }
                        )
        else:
            cleanRoundsSinceDowngrade = 0
        # Graceful degradation (mini-swe-agent / smolagents lesson): after
        # repeated malformed tool calls this round, downgrade the NEXT round
        # to the bare tool surface — fewer tools means less JSON to improvise.
        if parseFailures >= 3:
            if not surfaceDowngraded:
                tools = [t for t in toolDefinitions(session) if _toolDefName(t) in _BARE_TOOL_ALLOW]
                openaiTools = [
                    t for t in openaiToolDefinitions(session) if _toolDefName(t) in _BARE_TOOL_ALLOW
                ]
                surfaceDowngraded = True
                cleanRoundsSinceDowngrade = 0
                if emit:
                    emit(
                        {
                            'type': 'warning',
                            'message': (
                                'Repeated malformed tool calls — downgrading the tool surface to the '
                                'essential set (read/write/run_command/state) for the next round.'
                            ),
                        }
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
        if cancelledMidRound:
            # Never persist an assistant message whose tool calls lack results
            # — the next turn would replay dangling calls (Anthropic rejects
            # tool_use without tool_result; OpenAI gateways mangle them).
            contentVal = assistantMsg.get('content')
            if isinstance(contentVal, list):
                assistantMsg['content'] = [
                    b
                    for b in contentVal
                    if not (isinstance(b, dict) and b.get('type') == 'tool_use')
                ]
            assistantMsg.pop('tool_calls', None)
        currentMessages.append(assistantMsg)
        currentMessages.extend(toolResults)
        if planSubmittedThisRound:
            break
        if clarifySubmittedThisRound:
            break
    try:
        from app.services.hooks.lifecycle import emit_lifecycle
        from app.services.hooks.types import HookEvent as _StopEvent

        await emit_lifecycle(
            _StopEvent.STOP,
            sessionId,
            extra={'rounds': toolRound, 'error': turnError or ''},
        )
    except Exception:
        logger.debug('STOP hook failed (non-fatal)', exc_info=True)
    try:
        logger.debug('workbench turn complete: %d rounds, in=%d out=%d', toolRound, totalInputTokens, totalOutputTokens)
        session.messages = list(currentMessages)
        # Persist per-turn usage on the last assistant message: the SSE done
        # event is volatile, so without this the usage chip vanished after a
        # restart (fresh load from the session blob) — audit fix.
        try:
            if totalInputTokens > 0 or totalOutputTokens > 0:
                for m in reversed(session.messages):
                    if isinstance(m, dict) and m.get('role') == 'assistant':
                        m['usage'] = {
                            'inputTokens': totalInputTokens,
                            'outputTokens': totalOutputTokens,
                            'contextTokens': finalContextTokens,
                            'durationMs': int(totalGenerationMs),
                            'cacheHitTokens': totalCacheHitTokens,
                            'cacheMissTokens': totalCacheMissTokens,
                        }
                        break
        except Exception:
            logger.debug('per-turn usage attach failed', exc_info=True)
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
            # Session summary (D5): once per session, distill a free local
            # summary into the metadata and the Journey timeline.
            try:
                if (
                    session.messageCount >= 4
                    and not (session.metadata or {}).get('summary')
                    and getattr(session, 'metadata', None) is not None
                ):
                    from app.services.workbench.context_compressor import localSummarize

                    summary = localSummarize(list(session.messages), maxSummaryChars=800)
                    if summary.strip():
                        session.metadata['summary'] = summary.strip()
                        write_timeline_event(
                            session.id,
                            f'Session summary: {summary.strip()[:300]}',
                            category='summary',
                        )
            except Exception:
                logger.debug('session summary failed', exc_info=True)
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
                        cacheHitTokens=totalCacheHitTokens,
                        cacheMissTokens=totalCacheMissTokens,
                    )
                    session.totalInputTokens += totalInputTokens
                    session.totalOutputTokens += totalOutputTokens
                    session.cacheHitTokens = as_int(
                        getattr(session, 'cacheHitTokens', 0), 0
                    ) + totalCacheHitTokens
                    session.cacheMissTokens = as_int(
                        getattr(session, 'cacheMissTokens', 0), 0
                    ) + totalCacheMissTokens
                except Exception:
                    logger.exception('workbench record_usage failed')
    finally:
        current_subprocess_cancel.reset(_cancel_token)
        # Verifier auto-run (D3): when enforcement is on and the model ended
        # without completing the gate, run the stated verification command
        # once and steer the model to finish (phase='complete'). Only in
        # `full` guard mode — in ask/edit modes run_command requires user
        # approval, and auto-running it would bypass the approval gate
        # (audit finding).
        try:
            _guard_mode = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')
            _verifier_runs = as_int(getattr(session, '_verifier_auto_run_count', 0), 0)
            if (
                _guard_mode == 'full'
                and getattr(session, 'verifierEnforced', False)
                and _verifier_runs < 2
                and not _isCancelled()
            ):
                vstate = getattr(session, '_execution_state', None) or {}
                vphase = as_str(vstate.get('phase'), '') if isinstance(vstate, dict) else ''
                vcmd = as_str(vstate.get('verification_command'), '') if isinstance(vstate, dict) else ''
                if vphase != 'complete' and vcmd:
                    setattr(session, '_verifier_auto_run_count', _verifier_runs + 1)
                    vresult = await _executeTool('run_command', {'command': vcmd}, session)
                    vout = as_str(vresult, '')[-3000:]
                    receipts = getattr(session, '_verification_receipts', None)
                    if receipts is None:
                        receipts = []
                        setattr(session, '_verification_receipts', receipts)
                    receipts.append({'name': 'run_command', 'command': vcmd, 'content': vout})
                    if len(receipts) > 12:
                        del receipts[: len(receipts) - 12]
                    # Deterministic verdict (exit code is always surfaced by
                    # run_command now); marker scan is the fallback only.
                    exitMatch = re.search(r'exit code:\s*(-?\d+)', vout, re.IGNORECASE)
                    verifierPassed: bool | None
                    exitCodeStr = ''
                    if exitMatch:
                        exitCodeStr = exitMatch.group(1)
                        verifierPassed = int(exitCodeStr) == 0
                    else:
                        verifierPassed = None
                    if verifierPassed is True:
                        steer = (
                            '[VERIFIER AUTO-RUN] The verification command passed (exit code 0). '
                            "Call update_state(phase='complete') to release the final answer."
                        )
                    else:
                        verdictDetail = (
                            f'failed with exit code {exitCodeStr}' if verifierPassed is False else 'did not produce a clear exit code'
                        )
                        steer = (
                            '[VERIFIER AUTO-RUN] The verification command ran automatically and '
                            f'{verdictDetail}:\n{vout}\n'
                            'Fix the failures, re-run the command, and only then call '
                            "update_state(phase='complete')."
                        )
                    enqueueUserMessage(sessionId, steer, kind='steer')
                elif vphase != 'complete' and not vcmd:
                    # A7: the model ended with a withheld answer and never
                    # declared a verification command — steer it to declare +
                    # run one, instead of stranding the answer under the amber
                    # banner with no automatic recovery path. A second ignored
                    # steer force-releases the answer next turn (L4, bounded).
                    setattr(session, '_verifier_auto_run_count', _verifier_runs + 1)
                    if _verifier_runs >= 1:
                        setattr(session, '_verifier_force_release', True)
                        if emit:
                            emit(
                                {
                                    'type': 'warning',
                                    'message': (
                                        'Verifier gate: the model ignored the verification steer '
                                        'twice — the next answer will be released without a '
                                        'passing verification run.'
                                    ),
                                }
                            )
                    else:
                        # Suggest a verification command inferred from the
                        # task type (never auto-run — the model decides what
                        # actually validates its work).
                        suggestedCmd = ''
                        steer = (
                            '[VERIFIER STEER] The verifier gate requires a verification run before '
                            "the final answer is released. Declare and run a verification command "
                            f"(tests / lint / build{f' — suggested: {suggestedCmd}' if suggestedCmd else ''}) "
                            "via run_command, confirm it passes, then call "
                            "update_state(phase='complete', verificationCommand='<your command>')."
                        )
                        enqueueUserMessage(sessionId, steer, kind='steer')
        except Exception:
            logger.debug('verifier auto-run failed', exc_info=True)
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
                    'cacheHitTokens': totalCacheHitTokens,
                    'cacheMissTokens': totalCacheMissTokens,
                },
            }
            # D8: the message shows who actually answered when a
            # fallback/promotion switch happened mid-turn.
            if chainUsedAt:
                doneEvent['usedFallback'] = chainUsedAt
            emit(doneEvent)
    # LLM sidebar title after the first exchange (placeholder titles only).
    # Runs even for headless sessions — automation runs still deserve a
    # readable sidebar title.
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
    re.compile(
        r'\b(?:actually|correction)\s*[:,]?\s+(.{8,120})',
        re.IGNORECASE,
    ),
    re.compile(
        r'\b(?:that(?:\'s| is) (?:wrong|incorrect)[,.]?\s*)(.{8,120})',
        re.IGNORECASE,
    ),
    re.compile(
        r'\b(?:I meant|do not|don\'t|never)\s+(.{8,120})',
        re.IGNORECASE,
    ),
]


async def _executeTool(
    toolName: str, args: dict[str, object], session: WorkbenchSession, toolUseId: str = ''
) -> str:
    """Execute a workbench tool by dispatching to the correct handler.

    Two dispatch paths:
      * ``mcp__<server_id>__<tool>`` names route to the MCP client
        (``execute_mcp_tool_call``), which talks to the relevant MCP
        server subprocess over JSON-RPC.
      * everything else dispatches through ``tool_registry``.

    ``toolUseId`` (the parent tool call id) is published as a ContextVar so
    tool handlers can stamp their emitted events (e.g. subagentStart) with
    the parent call — the UI nests sub-agent blocks under it.
    """
    from app.services.tool_registry import dispatch as dispatchTool
    from app.services.workbench.context import currentSessionId, currentToolUseId

    token = currentSessionId.set(session.id)
    toolToken = currentToolUseId.set(toolUseId or '')
    try:
        from app.services.tools.mcp_client import executeMcpToolCall, isMcpToolName

        if isMcpToolName(toolName):
            try:
                return str(
                    await asyncio.wait_for(
                        executeMcpToolCall(toolName, args), timeout=_TOOL_EXEC_TIMEOUT_S
                    )
                )
            except asyncio.TimeoutError:
                return f'Error: MCP tool {toolName} timed out after {_TOOL_EXEC_TIMEOUT_S}s.'

        # Hash-anchored edits (surpass #5): mutating tools may carry the
        # sha256 of the file as read (the read tool reports it). A mismatch
        # means the file changed and the patch would corrupt it — reject and
        # tell the model to re-read instead of applying stale edits.
        # Whole-token matching: substring matching flagged read-style tools
        # (`read_creations` matched 'create', `find_and_replace` matched
        # 'replace') as mutating.
        name_l = (toolName or '').lower()
        if re.search(
            r'\b(?:write|edit|patch|str_replace|replace|create|delete|remove|move|rename|append)\b',
            name_l,
        ):
            expected = as_str(args.get('fileHash') or args.get('file_hash') or '', '')
            if expected:
                target = as_str(
                    args.get('path')
                    or args.get('filePath')
                    or args.get('file_path')
                    or args.get('file')
                    or '',
                    '',
                )
                if target:
                    import hashlib
                    from pathlib import Path

                    try:
                        # Expand ~ and resolve symlinks before hashing — a raw
                        # Path('~/x') is never a real file, so `~`-relative
                        # targets silently skipped the stale-write guard
                        # (audit finding), and unresolved symlinks read the
                        # wrong bytes.
                        p = Path(target).expanduser()
                        if not p.is_absolute():
                            ws = as_str(getattr(session, 'workspacePath', '') or '')
                            p = Path(ws) / p if ws else p
                        p = p.resolve()
                        if p.is_file():
                            actual = hashlib.sha256(p.read_bytes()).hexdigest()
                            if actual != expected.lower():
                                return (
                                    'Error: File changed since you read it (content hash mismatch). '
                                    'Re-read the file with the read tool, then retry the edit.'
                                )
                    except OSError:
                        pass

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
        except Exception as exc:
            # A PRE hook that raised cannot vet the call — the registered
            # pre-tool hooks are security guards (secret_guard, sensitive_code),
            # so failing CLOSED is the safe default: a broken hook must not
            # silently allow a credential write. The message names the hook
            # failure so the user can fix the hook config.
            logger.warning('PRE_TOOL_USE hook failed for %s — denying: %s', toolName, exc)
            return f'[BLOCKED by hook] Pre-tool hook failed to evaluate the call: {exc}'

        try:
            # The command runner's own max timeout equals _TOOL_EXEC_TIMEOUT_S
            # (300s) — give run_command-style tools grace past the harness cap
            # so a legitimately long command isn't cancelled mid-write at the
            # exact moment its own timeout expires (audit finding).
            toolTimeout = _TOOL_EXEC_TIMEOUT_S
            if toolName in ('run_command', 'bash', 'safe_python', 'terminal_command'):
                toolTimeout = _TOOL_EXEC_TIMEOUT_S + 30
            result = await asyncio.wait_for(dispatchTool(toolName, args), timeout=toolTimeout)
        except asyncio.TimeoutError:
            return f'Error: tool {toolName} timed out after {toolTimeout}s.'
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
        except Exception as exc:
            # POST hooks observe/modify an already-executed tool — a failure
            # here cannot roll the tool back, so log and continue (unlike the
            # PRE hook, which fails closed above).
            logger.warning('POST_TOOL_USE hook failed for %s: %s', toolName, exc)

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
        currentToolUseId.reset(toolToken)


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

    # Session-deletion tools promise "confirm with the user before deleting"
    # — deleting the session that is CURRENTLY executing would destroy the
    # transcript the user is reading mid-turn. That is never approvable from
    # inside the session itself, so it is blocked in EVERY guard mode
    # (Full Access included; the sidebar delete button is the user's path —
    # audit finding). Other sessions remain deletable.
    if toolName in ('delete_session', 'delete_sessions', 'delete_folder'):
        currentId = session.id
        blockReason = None
        if toolName == 'delete_session':
            target = as_str(args.get('sessionId') or args.get('session_id'), '')
            blockReason = currentId if (not target or target == currentId) else ''
        elif toolName == 'delete_sessions':
            ids = [
                as_str(i, '')
                for i in as_list(args.get('sessionIds') or args.get('session_ids'), [])
                if isinstance(i, str)
            ]
            blockReason = currentId if currentId in ids else ''
        elif toolName == 'delete_folder':
            folderId = as_str(args.get('folderId') or args.get('folder_id'), '')
            ownFolder = as_str(getattr(session, 'folderId', '') or '', '')
            blockReason = currentId if (ownFolder and folderId == ownFolder) else ''
        if blockReason:
            return (
                f"Tool '{toolName}' cannot delete the session that is currently running "
                f'({blockReason}). Ask the user to delete this chat from the sidebar — '
                'deleting other sessions is allowed.'
            )

    # Full Access: never queue Ask/Edit permission banners (including run_command).
    if mode == 'full':
        return None

    if mode == 'plan' and (not session.planApproved) and is_mutating(toolName, args):
        if is_plan_file_write(session, toolName, args):
            # The plan markdown is the only file writable in plan mode.
            return None
        # Advisory plan mode: low-risk trivial multi-file fixes are allowed with a warning
        # — only high-risk mutations are hard-blocked. Risk is inferred from tool type
        # and destructive bucket; shell and delete are always high.
        # FAIL-CLOSED: bf0b5f49 keyed this escape hatch on session.planRisk but
        # shipped no setter, so the default '' silently ALLOWED every non-shell
        # mutation in plan mode while prompts/docs still promised blocking
        # (round-3 audit). An UNASSESSED risk must block; only an explicit
        # low/medium assessment may take the advisory allowance.
        risk = str(getattr(session, 'planRisk', '') or as_str(getattr(session, '_plan_risk', '') or '')).lower()
        if risk in ('low', 'medium'):
            if toolName.lower() in ('run_command', 'delete_file', 'delete_session', 'delete_sessions', 'kill_daemon', 'kill_daemons', 'clear_blackboard'):
                pass  # high-risk: fall through to block
            elif is_shell_mutation(toolName, args):
                pass
            else:
                # Advisory — allow with soft warning (caller may surface).
                return None
        return (
            f"Tool '{toolName}' is destructive and cannot run in plan mode. "
            f'The only file you may write is the plan itself ({plan_file_relpath(session.id)}). '
            'Finish investigating with non-destructive tools, write the plan to that '
            'file, call `submit_plan`, and wait for the user to approve before executing.'
        )
    # Edit automatically: file edits proceed; shell/commands still need approval.
    # Cognitive budget hardening: at critical, nudge non-essential writes toward scratchpad/summarize/compact first.
    # This is advisory (not hard-blocked) but surfaces via deny string so model sees the prompt.
    try:
        _budget_bth = getattr(session, 'cognitiveBudget', None) or getattr(session, 'cognitive_budget', None)
        if isinstance(_budget_bth, dict):
            _press_bth = str(_budget_bth.get('attention_pressure') or _budget_bth.get('attentionPressure') or '').lower()
            _rem_bth = int(_budget_bth.get('remaining_tokens') or _budget_bth.get('remainingTokens') or 999999)
            if _press_bth == 'critical' or _rem_bth < 8000:
                if toolName not in ('write_scratchpad', 'summarize_session', 'compact', 'update_state') and is_mutating(toolName, args):
                    return (f"Cognitive budget critical ({_press_bth}, { _rem_bth} tokens left) — save key state via write_scratchpad and summarize_session, then compact before further writes. Tool '{toolName}' throttled.")
    except Exception:
        pass
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
    # Stash the pre-plan agent role so leaving plan mode can restore it —
    # plan mode must not permanently clobber a user-selected agent.
    prev_agent = as_str(getattr(session, 'agentId', '') or '')
    if prev_agent and prev_agent != 'plan':
        meta = dict(session.metadata or {})
        meta['planAgentId'] = prev_agent
        session.metadata = meta
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
            'edit_lines',
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
            'spawn_subagents',
            'spawn_daemon',
            'kill_daemon',
            'interrupt_subagent',
            'send_subagent_message',
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
        elif name in ('spawn_subagents', 'create_agent', 'list_agents', 'list_workstreams', 'send_subagent_message', 'interrupt_subagent'):
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
    # MCP tool-token split (U7): the context-ring popover breaks "system tools"
    # into built-in vs MCP so the user can see what an MCP server really costs.
    mcp_entries: list[dict[str, object]] = []
    for group_list in grouped.values():
        for e in group_list:
            if str(e['name']).startswith('mcp__'):
                mcp_entries.append(e)
    mcp_token_total = sum(as_int(e.get('estimated_tokens'), 0) for e in mcp_entries)
    return {
        'tools_by_group': grouped,
        'total_tools': len(allTools),
        'mutating_tools': sum((1 for t in allTools if (t.get('name') if isinstance(t, dict) else t) in _MUTATING_TOOLS)),
        'estimated_total_tokens': sum((len(str(t)) // 4 + 50 for t in allTools)),
        'mcp_tools': len(mcp_entries),
        'estimated_mcp_tokens': mcp_token_total,
        'agent_count': agentCount,
    }


def get_session() -> WorkbenchSession | None:
    """Get the active workbench session from the current context.

    Used by the update_state tool to read/write execution state.
    Prefers the ``currentSessionId`` ContextVar (set by ``_executeTool`` for
    the whole dispatch) so execution state / verifier receipts / scratchpad
    land on the session whose turn is actually executing — with ≥2 open
    chats, the max-``updatedAt`` heuristic resolved to the WRONG session
    (verifier gate verdict stuck 'none', false stall hard-stops, the wrong
    chat's agent mode rewired). Falls back to the most recently touched
    session only for callers outside a tool dispatch.
    """
    from app.services.workbench.context import currentSessionId

    sid = currentSessionId.get()
    if sid:
        s = _sessions.get(sid)
        if s is not None:
            return s
    if not _sessions:
        return None
    try:
        return max(_sessions.values(), key=lambda s: s.updatedAt or '')
    except (IndexError, ValueError):
        return None


async def updateSessionState(session: WorkbenchSession, executionState: dict) -> bool:
    """Update execution state on a session with an asyncio.Lock.

    Phase 5: ``asyncio.Lock`` per session around state mutations —
    parallel ``update_state`` and ``write_scratchpad`` calls are serialized
    per session, preventing dropped state updates. Lock timeout of 5 seconds
    prevents deadlock. Returns False when the lock was not acquired so the
    tool can surface a real error instead of reporting success for a write
    that was dropped (audit finding).
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
            return True
        finally:
            session._state_lock.release()
    except asyncio.TimeoutError:
        return False
    except RuntimeError:
        return False
