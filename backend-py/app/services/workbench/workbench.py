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
from app.services.workbench.durability import BARRIER_MODEL_DISPATCH as _BARRIER_MODEL_DISPATCH
from app.services.workbench.durability import BARRIER_STEP_BOUNDARY as _BARRIER_STEP_BOUNDARY
from app.services.workbench.durability import BARRIER_TOOL_SIDE_EFFECT as _BARRIER_TOOL_SIDE_EFFECT
from app.services.workbench.durability import flush_session_barrier as _flushSessionBarrier
from app.services.workbench.edit_verification import EDIT_TOOLS as _EDIT_VERIFY_TOOLS
from app.services.workbench.edit_verification import verify_after_edit as _verifyAfterEdit
from app.services.workbench.effort import (
    effort_to_openai_reasoning_effort,
    effort_to_prompt_instruction,
    effort_to_thinking_budget,
    resolve_effective_effort,
)
from app.services.workbench.permissions import COMMAND_TOOLS as _COMMAND_TOOLS
from app.services.workbench.permissions import ApprovalPolicy as _ApprovalPolicy
from app.services.workbench.read_before_edit import GATED_EDIT_TOOLS as _GATED_EDIT_TOOLS

# The hash-anchored-edit rejection that composes STALE_WRITE_HEADLINE now lives
# in loop/exec.py (P1#11 split), but the wording is re-imported here: this file
# must keep naming the shared sentence rather than a bespoke copy, and
# tests/test_learning_loop_wiring.py::TestStaleWordingSingleSource scans THIS
# file's source text to prove the retired phrasing did not creep back.
from app.services.workbench.read_before_edit import STALE_WRITE_HEADLINE as STALE_WRITE_HEADLINE
from app.services.workbench.read_before_edit import check_read_before_edit as _readBeforeEditGate
from app.services.workbench.read_before_edit import (
    observe_after_mutation as _observeMutatedFile,
)
from app.services.workbench.read_before_edit import (
    observe_from_read_result as _observeReadFile,
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
from app.services.workbench.tool_protocol import (
    canonical_tool_calls as _canonicalToolCalls,
)
from app.services.workbench.tool_protocol import (
    receipt_tone as _receiptTone,
)
from app.services.workbench.tool_protocol import (
    reconcile_tool_results as _reconcileToolResults,
)
from app.services.workbench.tool_protocol import (
    tool_result_failed as _toolResultFailed,
)
from app.services.workbench.validator import validationErrorText

logger = logging.getLogger('workbench')
# Tool-round cap. DISABLED by default (0 = unlimited): a hard 25-round cap
# killed long legitimate runs (big refactors, multi-step research) and read to
# the model as an arbitrary stop. Real runaway protection now comes from the
# stall detector below (phase/step stuck + novel-work check). Set
# brain-orchestrator maxWorkbenchToolLoops > 0 in Settings → Brain to opt back
# into a cap.
MAX_MANAGED_TOOL_ROUNDS = 0
# Recurring-task / daemon sub-agents run unbounded today (they bypass the
# orchestrator's worker pool). Cap concurrent runs so a burst of due tasks
# cannot spawn an arbitrary number of model calls at once.
MAX_RECURRING_SUBAGENT_CONCURRENCY = 3
_recurringSubagentSlots = asyncio.Semaphore(MAX_RECURRING_SUBAGENT_CONCURRENCY)
# One-turn-per-session invariant, enforced at the service layer:
# the router gate only covers POST /chat, but Bot DMs, room member turns,
# routine respond-turns, Live calls, and automations call
# sendWorkbenchMessageStream directly — two overlapping turns on one session
# interleave session.messages appends and race barrier flushes. Default
# behavior serializes (wait=True); unattended callers may pass wait=False to
# get a structured busy instead of queuing behind a live turn.
_turnLocks: dict[str, asyncio.Lock] = {}
# Backstop for `_turnLocks`. The lock is released when a session is deleted,
# but sessions also disappear by other routes — the startup window prune, a
# cap on how many are kept, a session id that never came back — and this dict
# never shrinks on its own. A desktop process runs for days, so a per-session
# object that is only ever added is a slow leak that a long session pays for
# in memory it cannot get back. Insertion order is preserved by dict, so the
# oldest entries are the front.
_MAX_TURN_LOCKS = 512


class SessionBusyError(RuntimeError):
    """A turn is already live on this session and the caller passed wait=False."""

    def __init__(self, sessionId: str) -> None:
        super().__init__(f'Session {sessionId} is already running a turn')
        self.sessionId = sessionId


def release_turn_lock(sessionId: str) -> bool:
    """Forget a session's turn gate. True when an entry was actually dropped.

    Refuses to drop a LOCKED gate: a turn is holding it, and removing the dict
    entry would let the next turn create a second lock for the same session —
    which is precisely the interleaving the gate exists to prevent. A locked
    entry is left for the prune below instead.
    """
    lock = _turnLocks.get(sessionId)
    if lock is None:
        return False
    if lock.locked():
        return False
    _turnLocks.pop(sessionId, None)
    return True


def _prune_turn_locks() -> None:
    """Oldest-first trim, skipping any gate a turn is currently holding."""
    if len(_turnLocks) <= _MAX_TURN_LOCKS:
        return
    for sessionId in list(_turnLocks.keys()):
        if len(_turnLocks) <= _MAX_TURN_LOCKS:
            break
        lock = _turnLocks.get(sessionId)
        if lock is not None and not lock.locked():
            _turnLocks.pop(sessionId, None)


def _sessionTurnLock(sessionId: str) -> asyncio.Lock:
    lock = _turnLocks.get(sessionId)
    if lock is None:
        lock = asyncio.Lock()
        _turnLocks[sessionId] = lock
        _prune_turn_locks()
    return lock


def service_turn_in_flight(sessionId: str) -> bool:
    """True while a sendWorkbenchMessageStream turn holds this session's gate.

    Router-side probe (activeChats, snapshot-prune guard) so unattended turns
    are visible outside the router's own _activeStreams map.
    """
    lock = _turnLocks.get(sessionId)
    return lock is not None and lock.locked()

# Error families: six different commands failing for one reason is one problem,
# but full-argument novelty alone calls it progress and never intervenes. The
# rules, advice, and classifier live in app/services/error_families.py — the
# one vocabulary shared with the turn_outcomes recorder (audit D8); the
# historical names stay importable from here for tests and callers.
from app.services.error_families import ERROR_FAMILY_ADVICE as _ERROR_FAMILY_ADVICE  # noqa: E402, F401
from app.services.error_families import ERROR_FAMILY_RULES as _ERROR_FAMILY_RULES  # noqa: E402, F401
from app.services.message_sources import SOURCE_HARNESS_NUDGE, SOURCE_QUEUED_USER  # noqa: E402

# Stall/novelty guards live in loop/guards.py (P1#11 split): the stall
# constants, canonical-argument identity, (tool, target) polling keys,
# world-delta recording, the recent error-family tally and the shared
# turn-end verdict — plus _bulk_paths_from_args (pure args-walker shared
# with the exec layer). Re-exported under the original names so the loop
# body below, subagent.py and the tests (wb._recordWorldDelta,
# wb._recent_error_families, …) keep resolving them on this module.
from app.services.workbench.loop.guards import (  # noqa: E402
    _ERROR_FAMILY_WINDOW,  # noqa: F401 -- re-export: guard helper (tests / callers read wb._ERROR_FAMILY_WINDOW)
    _POLL_TARGET_REPEATS,  # noqa: F401 -- re-export: guard helper (tests / callers read wb._POLL_TARGET_REPEATS)
    MAX_STALLED_ROUNDS,
    MIN_ROUNDS_BEFORE_STALL_CHECK,
    _assistant_round_is_novel,
    _bulk_paths_from_args,  # noqa: F401 -- re-export: its callers moved to loop/exec.py
    _canonicalArgs,  # noqa: F401 -- re-export: guard helper (tests / callers read wb._canonicalArgs)
    _countTarget,  # noqa: F401 -- re-export: guard helper (tests / callers read wb._countTarget)
    _error_family,  # noqa: F401 -- re-export: historical name stays importable (tests)
    _finalTurnEndReason,
    _pollingTarget,  # noqa: F401 -- re-export: guard helper (tests / callers read wb._pollingTarget)
    _recent_error_families,
    _recordWorldDelta,
    _runawayBudget,  # noqa: F401 -- re-export: guard helper (tests read wb._runawayBudget)
    _toolResultText,  # noqa: F401 -- re-export: guard helper (tests / callers read wb._toolResultText)
    _toolSig,  # noqa: F401 -- re-export: guard helper (tests / callers read wb._toolSig)
    _toolTarget,  # noqa: F401 -- re-export: guard helper (tests / callers read wb._toolTarget)
)

_ERROR_FAMILY_STREAK = 3
# Every injected reminder is runtime-only. Without this line a model files the
# nudge itself as a durable "lesson" and the memory store fills with the harness
# talking to itself.
_REMINDER_FOOTER = (
    'This is a runtime reminder for the current turn only — do not save it into '
    'memory, skills, or any persistent instruction file.'
)


# Code-mode (fenced python) execution cap.
_CODE_RUN_TIMEOUT_S = 60
# Tool dispatch cap: a hung MCP server or registry handler must not hold a
# turn (and a sub-agent semaphore slot) forever. Env-overridable. Guarded so a
# non-numeric AUGUST_TOOL_TIMEOUT_S falls back to the default instead of
# raising at module import and taking down the whole workbench.

# Clean rounds on the bare surface before the full tool set is restored
# (reversible downgrade — A6).
_DOWNGRADE_RECOVERY_ROUNDS = 3


def tailSectionSizes(
    memory: str | None,
    skills: str | None,
    state: str | None,
    nudge: str | None,
    skillsByName: dict[str, int] | None = None,
    workspace_map: str | None = None,
) -> dict[str, object]:
    """Byte size of each volatile per-turn tail block, for the context meter.

    Measured in UTF-8 bytes rather than characters, because that is what the
    meter calls them and a prompt with non-ASCII content would otherwise
    under-report its own size.

    A zero here means the block was genuinely not injected this turn — which is
    accurate, not an unknown. The distinction the UI has to get right (measured
    zero vs never measured) is made at the display layer; the producer only
    reports what it built.
    """
    return {
        'memoryBytes': len((memory or '').encode('utf-8')),
        'skillsBytes': len((skills or '').encode('utf-8')),
        'stateBytes': len((state or '').encode('utf-8')),
        'nudgeBytes': len((nudge or '').encode('utf-8')),
        # The workspace map moved here from the system block so its TTL can no
        # longer bust the provider prefix cache.
        'workspaceMapBytes': len((workspace_map or '').encode('utf-8')),
        # Which skill cost what — same pass that built the block, so the two
        # can never disagree about what was injected.
        'skillsByName': {
            name: size for name, size in (skillsByName or {}).items() if name and size > 0
        },
    }


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
_isResponsesProvider = _providers_mod.is_responses_provider
_extractText = _providers_mod.extract_text
_extractThinking = _providers_mod.extract_thinking
_supportsThinking = _providers_mod.supports_thinking
_callAnthropicWorkbench = _providers_mod.call_anthropic_workbench
_callOpenaiWorkbench = _providers_mod.call_openai_workbench
_callResponsesWorkbench = _providers_mod.call_responses_workbench


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
    # Latency fix (2026-09-02, measured live on Ifron free tier): the
    # "requires <plan> balance" family is a deterministic billing refusal
    # delivered on a 429 — it burned ~80 s of client+turn retries before
    # surfacing. 'balance' alone stays safe: August's own hint says
    # "billing/credits", not "balance".
    'team balance',
    'balance greater than',
    'balance is too low',
    'insufficient balance',
    'requires balance',
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

# T16(d): deterministic 400s — the request itself is malformed
# (orphaned tool-use id, broken message structure). Retrying re-sends the
# identical request forever (a documented field incident); these are
# fatal-or-repair, never transient. Checked before the marker scan so a
# message that happens to contain "timeout" still fails fast.
_DETERMINISTIC_400_MARKERS = (
    'tool_use_id',
    'tool use id',
    'tool_call_id',
    'orphan',
    'no tool call',
    'messages must alternate',
    'unexpected role',
    'invalid role',
    'unrecognized role',
    # These are request-shape rejections — the identical retry
    # fails identically, so classifying them as deterministic stops the
    # useless retry storm (each one verified against real upstream text).
    'budget_tokens',
    'thinking',
    'schema',
    'model not found',
)


def _isRetryableModelError(response: dict[str, object]) -> bool:
    """True when a failed model sub-call is worth retrying (429/5xx/network).

    Quota/billing failures are never retried: 402, or any message carrying a
    quota marker, even on a 429 status. Deterministic 400s (orphaned
    tool-use id, malformed message structure) are never retried either —
    the identical request would fail identically (T16d).
    """
    if not response.get('error'):
        return False
    status = response.get('errorStatus')
    if isinstance(status, int) and status in _QUOTA_STATUSES:
        return False
    msg = as_str(response.get('error')).lower()
    if any((m in msg for m in _QUOTA_MARKERS)):
        return False
    if isinstance(status, int) and status == 400 and any(
        (m in msg for m in _DETERMINISTIC_400_MARKERS)
    ):
        return False
    if isinstance(status, int) and status in _MODEL_RETRY_STATUSES:
        return True
    return any((marker in msg for marker in _MODEL_RETRY_MARKERS))


def _retryBlockedByPartialEmission(response: dict[str, object], emitted_content: bool) -> bool:
    """R-C idempotency gate: never replay a completion that
    already streamed generated tokens. Once text/thinking deltas reached
    the user, the provider has generated — and may have been billed for —
    those tokens, so even a retryable failure surfaces instead of retrying
    (double-billing prevention)."""
    return bool(emitted_content) and _isRetryableModelError(response)


# ── P0 replay-safety veto ───────────────────────────────────────────────
# `_retryBlockedByPartialEmission` only sees ONE model attempt: it stops the
# identical-body retry after that attempt streamed text. It says nothing
# about the round REPLAY paths — the tools-fallback, the context promotion,
# the fallback-chain model switch, and the narration self-heal — which each
# re-invoke the model for a round the turn may already have moved past.
#
# Two kinds of side effect make such a replay blind rather than safe:
#   * visible text — the user has already read half the answer, so a
#     second answer is a duplicate, and the provider may bill twice;
#   * an executed tool — the world has already moved (a file written, a
#     command run). Re-planning the same round against the mutated world
#     re-runs the same work, which is exactly the double-execution the
#     per-tool "never re-dispatch" guard exists to prevent, one layer up.
#
# The veto is deliberately scoped to REPLAY re-invocations. The plain
# same-body, same-round transient retry (429/5xx) stays allowed even after a
# tool ran: nothing is re-executed there, it just asks the model the same
# question again, and that is the turn's main recovery route. Only a
# request-changing rescue is refused once the turn has side effects.
_REPLAY_RESCUES = frozenset({'tools_fallback', 'context_promotion', 'chain_fallback', 'self_heal'})


def _replayVetoReason(
    rescue: str,
    *,
    emitted_text: bool,
    executed_tool: bool,
    text_vetoes: bool = True,
) -> str | None:
    """Why a replay rescue must be refused, or None when it is safe.

    ``rescue`` names the re-invocation being considered; an unknown rescue
    is treated conservatively (vetoed once the turn has side effects) so a
    new path cannot accidentally opt out of the gate.

    ``text_vetoes=False`` is for the narration self-heal only: the text that
    tripped the stream rule is precisely what the self-heal exists to throw
    away, so its presence is the trigger, not a side effect. The tool signal
    still vetoes it there — that is the double-execution case.
    """
    if rescue not in _REPLAY_RESCUES:
        return f'unknown replay rescue {rescue!r}'
    if executed_tool:
        return 'a tool already ran this turn, so re-invoking the model would re-plan against a mutated workspace'
    if emitted_text and text_vetoes:
        return 'visible text was already emitted this turn, so a replay would double-answer (and double-bill)'
    return None


# Request-surface text shaping — the tools-fallback note, the strip-tools
# rewrite, tool-result truncation + the stage-B output spill, the tool-use
# refusal detector, the [TOOLCALL] text tool protocol and the assistant-text
# setter — lives in loop/prompt.py (P1#11 split). Re-exported under the
# original names so the loop body and the tests (which read the spill
# constants through `wb.`) keep resolving them on this module.
from app.services.workbench.loop.prompt import (  # noqa: E402
    _REFUSAL_RE,  # noqa: F401 -- re-export: old name kept
    _SPILL_HEAD_CHARS,  # noqa: F401 -- re-export: test_output_spill_stage_b reads it via wb
    _SPILL_HEAD_LINES,  # noqa: F401 -- re-export: test_output_spill_stage_b reads it via wb
    _SPILL_RETRIEVAL_TOOLS,
    _SPILL_TAIL_CHARS,  # noqa: F401 -- re-export: test_output_spill_stage_b reads it via wb
    _SPILL_TAIL_LINES,  # noqa: F401 -- re-export: test_output_spill_stage_b reads it via wb
    _SPILL_THRESHOLD_CHARS,
    _TEXT_TOOLCALL_RE,  # noqa: F401 -- re-export: old name kept
    _TOOLS_FALLBACK_NOTE,  # noqa: F401 -- re-export: old name kept
    SPILL_FILE_DIR,  # noqa: F401 -- re-export: old name kept
    _isToolRefusal,
    _parseTextToolCalls,
    _setAssistantText,
    _spillToolResult,
    _splitSpillPreview,  # noqa: F401 -- re-export: test_output_spill_stage_b reads it via wb
    _stripTextToolCallLines,
    _stripToolsFromHistory,  # noqa: F401 -- re-export: old name kept
    _toolBlockText,  # noqa: F401 -- re-export: old name kept
    _truncateToolOutput,
    spill_file_relpath,  # noqa: F401 -- re-export: old name kept
)


def _modelRetryPolicy() -> dict[str, int]:
    """Retry policy with optional config.json overrides (workbench.retry).

    Default maxRetries 10: a provider hiccup (429/503/network) should ride
    out a real outage window instead of surfacing a failure after a few
    attempts. Each attempt is visible as a `retrying` pill, and the
    client's own ≤3 pre-first-token backoffs stack underneath. Override
    per config.json workbench.retry.maxRetries when a provider needs a
    tighter or looser budget."""
    policy = {'maxRetries': 10, 'baseDelayMs': 1000, 'maxDelayMs': 30000, 'toolsFallback': 1}
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


# Recovery/telemetry event frames live in loop/events.py (P1#11 split): the
# one unified recovery frame every self-correction rescue emits (audit
# P0#6 / D9). Re-exported under the original name so the loop body and any
# external reader keep resolving it on this module.
# Context-overflow detection, the reactive prune-then-compact rescue, the turn
# budget ladder and its compaction rung live in loop/recovery.py (P1#11 split),
# together with the transcript landmark pins the compaction paths share.
# Re-exported under the original names so the loop body, subagent.py and the
# tests keep resolving them on this module.
from app.services.workbench.loop.events import _emitCompactionEvent, _emitRecovery  # noqa: E402
from app.services.workbench.loop.recovery import (  # noqa: E402
    _BUDGET_FINAL_DIRECTIVE,  # noqa: F401 -- re-export: loop appends it to the system text
    _BUDGET_LADDER,
    _CONTEXT_OVERFLOW_MARKERS,  # noqa: F401 -- re-export: readers introspect the marker list
    _budgetBreached,
    _budgetTriggeredCompaction,
    _is_failing_receipt,  # noqa: F401 -- re-export: subagent.py compaction pins
    _is_update_state_transition,  # noqa: F401 -- re-export: subagent.py compaction pins
    _isContextOverflowError,
    _msgTextLower,  # noqa: F401 -- re-export: old name kept
    _nextBudgetStep,
    _reactiveContextReduction,
    _turnBudget,
    _turnSpendUsd,
)


def _chatFallbackChain() -> list[str]:
    """Configured fallback chain (fleet ``chat_chain``, comma-separated ids)."""
    try:
        from app.services.model_fleet_service import getModelForRole

        raw = getModelForRole('chat_chain')
        return [m.strip() for m in raw.split(',') if m.strip()]
    except Exception:
        return []


def _chatContextPromotion() -> tuple[str, str]:
    """Configured larger-context sibling (fleet ``chat_context_promotion``) and
    the gateway it was configured against. Without the gateway a promotion to
    ``stepfun/step-3.7-flash`` lands on whichever provider lists that id first."""
    try:
        from app.services.model_fleet_service import resolveRoleModel

        model, provider = resolveRoleModel('chat_context_promotion')
        return model.strip(), provider.strip()
    except Exception:
        return '', ''


def _managedToolLoopCap() -> int:
    """Effective tool-round cap for this turn.

    brain-orchestrator ``maxWorkbenchToolLoops`` (Settings → Brain) overrides
    the module default; 0 disables the cap entirely.
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
    # Absent key → MAX_MANAGED_TOOL_ROUNDS, which has been 0 (uncapped) since
    # 38944632. This line used to claim 25 in both the docstring and here,
    # which is what AGENTS.md then repeated (audit finding 2026-09-15 #6).
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
    """Assemble the lean system prompt for a workbench session.

    Single-pass build with no memory recall, no heuristics and no skill
    relevance scoring: core operating rules, the two harness skills
    inlined, workspace context (VCS + AUG.md), live session state and the
    tool protocol. Expensive pieces (git probe, skill bodies, capabilities
    block) are memoized so a turn never pays for them twice.

    An <intake> manifest up top enumerates everything the context carries
    (role, agent notes, workspace/git, session state, memory, skills, date,
    tools) so the model can answer "what did you receive?" precisely
    instead of guessing.
    """
    from app.services.workbench import prompt_segments_cache as _seg_cache

    session._last_recalled_memories = None
    session._last_context_snapshot = None
    is_worker = int(getattr(session, 'subagent_depth', 0) or 0) > 0

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
    offeredTools = set(tool_names)

    workspacePath = (
        str(session.workspacePath)
        if hasattr(session, 'workspacePath') and session.workspacePath
        else ''
    )
    # User/workspace hooks (.aug/hooks.json) are (re)loaded here — mtime-gated
    # so unchanged files cost two stats. The workbench is the only engine that
    # emits tool events, so registering per prompt build covers every session
    # kind (chat, bot, subagent) and picks up hand-edited configs by next turn.
    try:
        from app.services.hooks.user_hooks import ensure_hooks_loaded

        ensure_hooks_loaded(workspacePath or None)
    except Exception:
        logger.debug('prompt: user hook load failed', exc_info=True)
    # If that workspace defines hooks the trust gate is currently suppressing,
    # say so HERE rather than letting the user watch nothing happen. This is
    # the one place in the engine that loads user hooks, so the notice cannot
    # be forgotten at a second call site. It is empty whenever no gate is
    # active, so it costs no context for anyone who has not hit it, and it
    # changes only when the user approves or revokes — a deliberate action
    # that is worth one prefix-cache invalidation.
    hookTrustNotice = ''
    if workspacePath:
        try:
            from app.services.hooks.user_hooks import inactive_notice

            hookTrustNotice = inactive_notice(workspacePath)
        except Exception:
            logger.debug('prompt: hook trust notice failed', exc_info=True)
    vcsInfo = ''
    whatsNew = ''
    if workspacePath:
        # Frozen for the session's lifetime: the workspace block sits in the
        # cached system-prompt prefix, and a fresh probe would re-render it
        # after every commit or dirty flip (probe TTL 60s), invalidating the
        # provider's prefix cache once per state change. Fresh vcs state is
        # still visible to the user in the UI, which probes independently.
        frozenVcs = getattr(session, '_frozen_vcs', None)
        if frozenVcs is None:
            vcsInfo, whatsNew = _probe_workspace_git(workspacePath)
            try:
                session._frozen_vcs = (vcsInfo, whatsNew)  # type: ignore[attr-defined]
            except Exception:
                pass
        else:
            vcsInfo, whatsNew = frozenVcs
    augMdBody = ''
    if workspacePath:
        try:
            from app.services import aug_directive_service

            # Layered load — global → git-root→cwd walk, override wins,
            # 32 KiB cap (least-specific layers dropped first).
            loaded = aug_directive_service.load_layered(workspacePath)
            if loaded and loaded.get('body'):
                augMdBody = as_str(loaded.get('body', ''))
        except Exception:
            logger.debug('prompt: AGENTS.md layered load failed', exc_info=True)

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
        '(research | plan | implement | review | complete); finish on complete. '
        'For checklists the user can see and tick, use submit_todos / update_todos.\n'
        '- Never invent file contents or command output.\n'
        '</core>'
    ]
    # The model's OWN pre-completion checklist — a self-check
    # against the original instruction, never a critic gate (verifier gate
    # removed 2026-08-24; nothing withholds the answer).
    if offeredTools:
        parts.append(
            '<completion_checklist>\n'
            'Before declaring work complete, check it yourself:\n'
            '1. Re-read the original instruction — every asked item is done, or you say what is not.\n'
            '2. Verification actually ran (tests/build/lint for the change) and you report its real result — failures included.\n'
            '3. No placeholders, stubs, or leftover TODOs in the files you changed.\n'
            '4. Error paths and edge cases of the change are considered.\n'
            '5. Your final message states the outcome with evidence (commands, exit codes, test counts).\n'
            'This is your own checklist — no other gate stands between you and your answer.\n'
            '</completion_checklist>'
        )
    # Per-model-family prompt variant (short framing block keyed by
    # the model id family; unknown families get nothing).
    try:
        from app.services.workbench.prompt_variants import family_prompt_variant

        familyVariant = family_prompt_variant(as_str(getattr(session, 'model', ''), ''))
        if familyVariant:
            parts.append(familyVariant)
    except Exception:
        logger.debug('prompt: family variant lookup failed', exc_info=True)
    # Intake manifest: enumerate exactly what this context carries so the
    # model can answer "what did you receive at the start?" precisely —
    # the way strong assistants self-describe their intake.
    skillNames: list[str] = []
    try:
        from app.services import session_scope as _scope_svc
        from app.services import skill_service as _skill_service

        # Thread the session's resolved scope — a Bot's private
        # skills belong in the intake list too (the <relevant_skills> tail and
        # load_skill already see them; the Tier-1 surfaces were half-wired).
        _tierScope = _scope_svc.resolve_scope(session)
        skillNames = sorted(
            str(s.get('name') or '')
            for s in _skill_service.catalogue(
                workspacePath or None, agent_id=_scope_svc.bot_agent_id(_tierScope)
            )
            if s.get('name')
        )
    except Exception:
        logger.debug('prompt: skill catalogue failed', exc_info=True)
    shownSkills = skillNames[:40]
    skillsLine = ', '.join(shownSkills)
    if len(skillNames) > len(shownSkills):
        skillsLine += f' … +{len(skillNames) - len(shownSkills)} more (list_skills for all)'
    memoryTools = sorted(
        n for n in ('brain_query', 'read_blackboard') if n in offeredTools
    )
    intake: list[str] = [
        '<intake>',
        'Context manifest — everything you received at the start of this conversation:',
        '- System prompt: your role, operating rules, and tool protocol.',
        (
            f'- Agent notes: AUG.md project instructions ({len(augMdBody)} chars), included below.'
            if augMdBody
            else '- Agent notes: none found for this workspace.'
        ),
        (
            f'- Workspace: {workspacePath}'
            + (f' · git: {vcsInfo}' if vcsInfo else '')
            + ' · file map'
            + (' + recent commits' if whatsNew else '')
            + ' in <workspace>.'
            if workspacePath
            else '- Workspace: none open (file tools bind to the system temp area).'
        ),
        '- Session state: goal, plan, execution phase, scratchpad, todos — in the per-turn '
        '<session_state> block appended to your latest message.',
    ]
    if memoryTools:
        # Dropped the `heuristics` hint — the table is deleted once
        # empty (no live writer), so advertising it made brain_query(heuristics)
        # answer "table not yet created" for a store the prompt named.
        storeHint = (
            'stores: facts=durable memory (titled entries), memory=kv notes, timeline=episodic, '
            'sessions=past chats.'
        )
        try:
            from app.services import brain_config_service as _bc

            # Per-turn auto-injection is its OWN flag (default off): the
            # relevance-matched <memory> tail rides the latest message only
            # when set. The boot index below is NOT gated by it (ZCode-parity
            # 044: the memory index is always in context at session start,
            # like this environment's MEMORY.md); modelMemoryRead still gates
            # the read tool itself, which is what advertises memoryTools.
            memReadOn = bool(_bc.getRuntimeConfig().get('memoryAutoInject', False))
        except Exception:
            memReadOn = False
        if memReadOn:
            memParts = [
                '- Memory: relevant stored facts auto-inject each turn (a <memory> block '
                'appended to the latest user message); pull deeper context on demand via '
                + ', '.join(memoryTools) + '. ' + storeHint
            ]
        else:
            # memoryAutoInject off: no per-turn <memory> block — the model
            # pulls relevant facts on demand via the read tools (gated by
            # modelMemoryRead, independent of auto-injection). The boot index
            # still names what exists.
            memParts = [
                '- Memory: auto-injection is OFF (memoryAutoInject); pull stored context '
                'on demand via ' + ', '.join(memoryTools) + '. ' + storeHint
            ]
        # Boot index (B3, ZCode-parity 044): one line per stored fact —
        # title (key) — recall hook — so the model always knows what it
        # remembers and can read/update/forget by key without a list_facts
        # round-trip. Frozen per session: this block sits near the TOP of the
        # prompt, so a fresh read each turn (new timeline rows land after every
        # completed turn) would change those bytes and invalidate the
        # provider's entire prefix cache — the "chat feels slow" regression.
        # Fresh memory still reaches the model two ways: the per-turn <memory>
        # tail block (byte-stable system prompt, appended to the latest user
        # message) and brain_query on demand.
        frozen = getattr(session, '_frozen_mem_index', None)
        if frozen is None:
            try:
                from app.services import session_scope as _ss
                from app.services.memory_store import brain_index_snippet as _brain_index

                frozen = _brain_index(_ss.resolve_scope(session)).strip()
            except Exception:
                frozen = ''
            try:
                session._frozen_mem_index = frozen
            except Exception:
                pass
        memIdx = frozen
        if memIdx:
            memParts.append('  Memory index (one line per fact — title (key) — recall hook; '
                            'read via brain_query store=facts):')
            for ln in memIdx.splitlines():
                memParts.append('  ' + ln)
        # Frozen per-session project-memory index (titles
        # only) — same freeze discipline as the global index above so hand
        # edits to the md files don't bust the cached prefix mid-session;
        # fresh entries still reach the model via the per-turn <memory> tail.
        _projIdx = getattr(session, '_frozen_project_index', None)
        if _projIdx is None:
            _projIdx = ''
            try:
                from app.services import brain_config_service as _pbc

                _projOn = bool(_pbc.getRuntimeConfig().get('projectMemory', True))
            except Exception:
                _projOn = True
            if _projOn and workspacePath and hasattr(session, 'workspacePath'):
                try:
                    from app.services import project_memory as _pm

                    _projIdx = _pm.project_block(workspacePath)
                except Exception:
                    logger.debug('prompt: project block failed', exc_info=True)
                    _projIdx = ''
            try:
                session._frozen_project_index = _projIdx  # type: ignore[attr-defined]
            except Exception:
                pass
        if _projIdx:
            for ln in _projIdx.splitlines():
                memParts.append('  ' + ln)
        intake.append('\n'.join(memParts))
    if skillsLine:
        intake.append(f'- Skills: {skillsLine}. Bodies load on demand via load_skill.')
    if tool_names:
        intake.append(f'- Tools: {len(tool_names)} registered this turn (details in <capabilities>).')
    intake.append('</intake>')
    parts.append('\n'.join(intake))
    if hookTrustNotice:
        parts.append(hookTrustNotice)
    if not is_worker:
        # The tool-directed half of the guide is filtered by the surface the
        # model was actually offered: a bare/reduced surface has no
        # load_skill / module_context / harness_propose / submit_plan, and
        # naming them there teaches the model to call a tool that cannot
        # answer (see harness_guide_for).
        guide = harness_guide_for(offeredTools)
        if guide:
            parts.append(f'<harness_guide>\n{guide}\n</harness_guide>')
    if workspacePath:
        ws = ['<workspace>', f'path: {workspacePath}']
        if vcsInfo:
            ws.append(f'vcs: {vcsInfo}')
        if whatsNew:
            ws.append(whatsNew)
        ws.append('</workspace>')
        parts.append('\n'.join(ws))
        if augMdBody:
            parts.append(f'<aug_directives>\n{augMdBody}\n</aug_directives>')
    # Phase L (Part 17, 2026-08-29): the <session> block stays BYTE-STABLE for
    # the whole session lifetime — id/title/goal/plan/plan-status/
    # execution_state/scratchpad/last_tool_failure/todos were moved OUT of the
    # system prompt into the per-turn <session_state> tail block on the last
    # user message (same injection point as <memory>/<relevant_skills>).
    # Why: the provider prompt-cache breakpoint covers the WHOLE system block
    # (adapters/anthropic.py marks the last system block), so ANY byte diff —
    # a title change, a plan update, a todo tick — re-read 100% of a ~29k-char
    # prompt upstream. Worse, the embedded `id:` made each new session's
    # system block unique, so turn 1 of every new chat was a guaranteed cold
    # read. Freshness is not lost: receipts already re-inject plan state into
    # the message stream mid-turn (_planStateBlock / _injectPlanState), and
    # the tail block re-renders the same state every turn. Only fields that
    # are byte-stable for the session lifetime AND genuinely model-facing
    # stay here (guardMode, agentMode, the circuit-mode hint).
    agentMode = as_str(getattr(session, 'agent_mode', '') or '')
    sessionBlock = ['<session>']
    # GuardMode (the approval policy for mutations) is orthogonal to
    # the sandbox containment level reported on command denials ([sandbox:soft]);
    # the bare "guardMode: full" read as if it contradicted a sandbox:soft denial.
    # Keep the `guardMode:` token (prompt-cache stability test) and annotate it.
    sessionBlock.append(
        'guardMode: '
        + normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')
        + ' (approval policy; sandbox containment is separate)'
    )
    if agentMode:
        sessionBlock.append(f'agentMode: {agentMode}')
    # /circuit workbench hint: when active, tell the model which tools exist
    # and how to use them (the catalog filter exposes circuit_* tools only
    # in this mode — see toolDefinitions / openaiToolDefinitions).
    try:
        from app.services.tools.circuit_tools import CIRCUIT_HINT, is_circuit_mode

        if is_circuit_mode(session):
            sessionBlock.append(f'circuit: {CIRCUIT_HINT}')
    except Exception:
        pass
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
    if tool_names:
        # The capabilities memo is keyed by workspace path
        # TOO — per-workspace catalogues (project skills shadowing) must not
        # cross-contaminate sessions; a mutation still busts every key via
        # clear_skill_prompt_caches().
        capsKey = f'{workspacePath or ""}\n' + '\n'.join(sorted(tool_names))
        caps = _caps_block_cache.get(capsKey)
        if caps is None:
            try:
                # Part 18 P1.2/P2.1: the main-agent Tier-1 index is NAME-ONLY
                # (compact_skills) — descriptions ride in the per-turn
                # <relevant_skills> tail instead, so name-only catalog grows
                # without re-reading the cached prefix and in-place
                # description edits keep the system prompt byte-stable.
                from app.services import session_scope as _ss_caps
                from app.services import skill_service as _sk_svc
                from app.services.capabilities_prompt import build_capabilities_block

                _capsScope = _ss_caps.resolve_scope(session)
                caps = build_capabilities_block(
                    tool_names,
                    catalogue=_sk_svc.catalogue(
                        workspacePath or None, agent_id=_ss_caps.bot_agent_id(_capsScope)
                    ),
                    compact_skills=True,
                )
            except Exception:
                logger.debug('prompt: capabilities block failed', exc_info=True)
                caps = ''
            _caps_block_cache[capsKey] = caps
        if caps:
            parts.append(f'<capabilities>\n{caps}\n</capabilities>')
    # Conditional policy blocks: only when the matching tools are offered.
    # CLARIFY stays unconditional. The stated reason was WRONG and has been
    # corrected by tests/test_prompt_instruction_honesty.py: `submit_clarify`
    # IS registered (tool_registrations/system_tools.py:498, asserted by
    # test_part27_fixes.py) as well as loop-intercepted. So this block is not
    # the model's only source of the schema, and on a bare/reduced surface
    # `submit_clarify` is in neither _BARE_TOOL_ALLOW nor AUGUST_CORE_TOOLS —
    # an instruction naming a tool that surface cannot call. It is left
    # ungated deliberately for now; gating it on `offeredTools` is the fix.
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
    # Memory write-door guidance only when the tool is actually offered and the
    # user has model memory writes enabled (the handler double-checks the toggle).
    if 'remember' in offeredTools:
        try:
            from app.services import brain_config_service as _bc

            memWritesOn = bool(_bc.getRuntimeConfig().get('modelMemoryWrites', True))
        except Exception:
            memWritesOn = True
        if memWritesOn:
            parts.append(_seg_cache.MEMORY_BLOCK)
    # The Bot roster + messaging protocol, offered ONLY where the
    # message_agent tool is (canonical Bot Chats — offeredTools already
    # reflects the filter_dm_tools gate, so bytes stay stable elsewhere).
    if 'message_agent' in offeredTools:
        try:
            from app.services.bot_mode import dm as _dm

            _messaging = _dm.messaging_hint(as_str(getattr(session, 'agentId', '') or ''))
            if _messaging:
                parts.append(_messaging)
        except Exception:
            logger.debug('prompt: agent-messaging block failed', exc_info=True)
    # Phase E guard (prompt layer 1): a bot-scoped session is told its memory
    # + skills are its own. Deterministic + stable per session (cache-safe).
    try:
        from app.services import session_scope as _ss

        _scope = _ss.resolve_scope(session)
        if _ss.is_bot_scope(_scope):
            _agent_id = _ss.bot_agent_id(_scope)
            try:
                from app.services.bot_mode import roster as _roster

                _bot = _roster.get_bot(_agent_id)
                _handle = as_str(_bot.get('name')) if _bot else _agent_id
            except Exception:
                _handle = _agent_id
            parts.append(
                f'You are Bot @{_handle}. Your skills live in your own folder and '
                'your memory is scoped to you plus the shared global store; other '
                "Bots' private skills and notes are not visible to you. Do not "
                'write into another Bot\'s scope.'
            )
    except Exception:
        logger.debug('prompt: bot-scope guard line failed', exc_info=True)
    # T15 versioned refine store: active prompt-note/memory entries ride along
    # as ADDITIONAL context — the immutable base system prompt is never edited.
    try:
        from app.services.refine_store import render_refinements_block

        refinements = render_refinements_block(session.id)
        if refinements:
            parts.append(refinements)
    except Exception:
        logger.debug('prompt: refine store block failed', exc_info=True)
    return '\n\n'.join(p for p in parts if p)




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




# State-block renderers live in state_blocks.py (Part 22 split): the
# per-turn <plan_state>/<session_state> tail, compaction/daemon ambient
# lines, and the post-compaction transcript re-injection. Re-exported so
# wb._planStateBlock (tests, receipts) resolves to the same functions.
# Prompt-assembly helpers live in prompt_build.py (Part 22 split, P3):
# git workspace probe, model display name, harness-guide/capabilities memos,
# clear_skill_prompt_caches, memory-habit nudge. Re-exported so every old
# reference site (tests via wb.*, skill_service's import, the prompt builder
# itself) resolves to THE SAME function objects and THE SAME memo dicts —
# clearing through either path clears the cache, no orphan second dict.
from app.services.workbench import turn_close as _tc  # noqa: E402
from app.services.workbench.prompt_build import (  # noqa: E402
    _HARNESS_GUIDE_DIGEST,  # noqa: F401 -- re-export: tests read wb._HARNESS_GUIDE_DIGEST
    _MEMORY_NUDGE_MIN_ROUNDS,  # noqa: F401 -- re-export: tests read wb._MEMORY_NUDGE_MIN_ROUNDS
    _caps_block_cache,
    _git_probe_cache,  # noqa: F401 -- re-export: tests clear the probe memo via wb
    _harness_guide_cache,  # noqa: F401 -- re-export: the memo dict is shared, not copied
    _harness_guide_text,  # noqa: F401 -- re-export: tests clear/read the memo via wb
    _modelDisplayName,
    _probe_workspace_git,
    clear_skill_prompt_caches,  # noqa: F401 -- re-export: old import path (skill_service fallback, tests)
    harness_guide_for,
    memory_nudge_block,
    queue_memory_habit_nudge,  # noqa: F401 -- re-export: tests + turn_close resolve via wb
)
from app.services.workbench.state_blocks import (  # noqa: E402
    _injectPlanState,  # noqa: F401 -- re-export: test_plan_state_t7 resolves it via wb
    _planStateBlock,
    _session_cost_usd,
    _sessionStateBlock,
)
from app.services.workbench.turn_close import (  # noqa: E402
    lastUserMessageText as _lastUserMessageText,  # noqa: F401 -- re-export: old name kept
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


# Auto-compact when estimated history reaches this fraction of the model window.
# Fallback window when a model's real contextWindow cannot be resolved.
# Three sites hardcoded this value independently; one constant now.
# This one and the resolver below stay in THIS file on purpose:
# tests/test_compaction_threshold_authority.py reads this file's source text
# and asserts the fallback window appears exactly once in it.
DEFAULT_CONTEXT_WINDOW = 128000


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
    return DEFAULT_CONTEXT_WINDOW


# Per-model tool surface: the guard-mode normalizer, the transcript result
# cap, the capability profile (full/reduced/bare/text) and the MCP tool tails
# live in loop/surface.py (P1#11 split). Re-exported under the original names.
# The two BUILDER functions below stay here on purpose: tests monkeypatch the
# module-level `_resolveModelContextWindow` on THIS module and expect the
# builders to read it from here.
from app.services.workbench.loop.surface import (  # noqa: E402
    _BARE_TOOL_ALLOW,
    _CAPABILITY_PROFILE_TTL_S,  # noqa: F401 -- re-export: the TTL is asserted via wb
    MAX_TOOL_RESULT_CHARS,  # noqa: F401 -- re-export: old name kept
    _applyModelCapabilityProfile,  # noqa: F401 -- re-export: test_harness_fixes calls it via wb
    _capability_profile_cache,  # noqa: F401 -- re-export: the memo is cleared through wb
    _finalize_session_tools,
    _mcpToolDefinitionsAnthropic,
    _mcpToolDefinitionsOpenai,
    _modelCapabilityProfile,  # noqa: F401 -- re-export: old name kept
    _toolDefName,
    _toolResultCap,
    normalizeGuardMode,
)


def _canRetrieveSpill(
    tools: list[dict[str, object]] | None,
    openai_tools: list[dict[str, object]] | None,
    session: WorkbenchSession,
) -> bool:
    """Can the model still read a spilled tool result back this turn?

    Named and module-level so the decision is testable: the bug this replaces
    lived inline in a 6.5k-line loop where no test could reach it, and the
    existing stage-B tests passed the whole time because they only exercised
    the ``_spillToolResult`` helper, never the call site's verdict.

    ``tools`` is populated ONLY on the Anthropic wire; on OpenAI/Responses it
    stays ``[]`` (:2626-2629). Reading it alone made ``offeredNames`` empty,
    ``canRetrieve`` False, and the helper returned None — so an oversized
    result was hard-truncated with no ``.aug`` file and nothing to re-read,
    on the wire formats most providers speak. The text tool protocol parses
    every registered tool natively, so it can always read back.
    """
    live = tools or openai_tools or []
    offered = {_toolDefName(t) for t in live}
    return bool(offered & _SPILL_RETRIEVAL_TOOLS) or bool(
        getattr(session, '_text_tool_protocol', False)
    )


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
        contextWindow = DEFAULT_CONTEXT_WINDOW
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
    # /circuit gate: circuit_* tools only exist while the session's circuit
    # workbench is active (see tool_registrations.circuit_tools).
    try:
        from app.services.tool_registrations.circuit_tools import filter_circuit_tools

        tools = filter_circuit_tools(tools, session)
    except Exception:
        pass
    # Phase C gate: message_agent only in a Bot's canonical chat (the tool
    # executor re-checks, so a forged call from elsewhere fails closed).
    try:
        from app.services.bot_mode.dm import filter_dm_tools

        tools = filter_dm_tools(tools, session)
    except Exception:
        pass
    return _finalize_session_tools(session, tools)




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
    # Run the same BM25-budgeted progressive disclosure as the
    # Anthropic builder. The OpenAI path previously shipped the full registry
    # (~80 KB JSON, ≈20k tokens) to every model without a capability profile —
    # the dominant trigger of deterministic gateway 500s while a few-KB chat
    # body from other harnesses succeeds on the same model+provider.
    try:
        from app.services.tools.model_tools import assembleToolDefs

        messages = getattr(session, 'messages', None) or []
        contextMsgs = list(messages) if isinstance(messages, list) else []
        # Budget against the session model's REAL window (same as the
        # Anthropic builder) — a 32k model must not be offered a 200k budget.
        contextWindow = DEFAULT_CONTEXT_WINDOW
        try:
            modelId = as_str(getattr(session, 'model', ''), '')
            providerCfg = as_dict(getattr(session, 'provider', None), {})
            if modelId:
                contextWindow = _resolveModelContextWindow(modelId, providerCfg or None)
        except Exception:
            logger.debug('tool-defs context window resolve failed', exc_info=True)
        # assembleToolDefs ranks by top-level `name` (Anthropic shape) — shim
        # the OpenAI defs into that shape for ranking, then map the selected
        # names back onto the original OpenAI-format definitions.
        byName: dict[str, dict[str, object]] = {}
        anthShim: list[dict[str, object]] = []
        for t in tools:
            name = _toolDefName(t)
            if not name or name in byName:
                continue
            byName[name] = t
            fn = as_dict(t.get('function'), {})
            anthShim.append(
                {
                    'name': name,
                    'description': as_str(t.get('description') or fn.get('description'), ''),
                    'input_schema': as_dict(t.get('parameters') or fn.get('parameters'), {}),
                }
            )
        result = assembleToolDefs(
            all_tool_defs=anthShim, context_messages=contextMsgs, contextLength=contextWindow
        )
        if result.activated:
            session._tool_assembly = result
            tools = [
                byName[as_str(td.get('name'), '')]
                for td in result.tool_defs
                if as_str(td.get('name'), '') in byName
            ]
    except Exception:
        logger.debug('openai progressive tool disclosure failed', exc_info=True)
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
    # /circuit gate (OpenAI path): same visibility rule as toolDefinitions.
    try:
        from app.services.tool_registrations.circuit_tools import (
            _is_circuit_gate_tool,
        )
        from app.services.tools.circuit_tools import is_circuit_mode

        def _circuit_gate_name(t: dict[str, object]) -> str:
            fn = as_dict(t.get('function'))
            return as_str(fn.get('name') or t.get('name'))

        if session is None or not is_circuit_mode(session):
            tools = [t for t in tools if not _is_circuit_gate_tool(_circuit_gate_name(t))]
    except Exception:
        pass
    # Phase C gate (OpenAI path): same visibility rule as toolDefinitions.
    try:
        from app.services.bot_mode.dm import filter_dm_tools

        tools = filter_dm_tools(tools, session)
    except Exception:
        pass
    return _finalize_session_tools(session, tools)




def _formatQueuedMessagesAsUserTurn(entries: list[dict[str, object]]) -> dict[str, object]:
    """Build a single user-role message that wraps one or more queued/steer entries.

    Steers (``kind=steer``) are mid-run course corrections and take priority
    in the preamble. Subagent completions (``kind=subagent``) are next so the
    model sees per-subagent results as they settle. Ordinary queue entries
    are follow-ups for later.
    """
    if not entries:
        return {'role': 'user', 'content': '', 'source': SOURCE_QUEUED_USER}

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
            atts = as_list(entry.get('attachments'), [])
            attachmentCount = len(atts)
            # An uploaded attachment carries the workspace path the frontend
            # stored it at — name it so analyze_media/read_file can open it;
            # a bare count told the model nothing (the bytes sat in the queue
            # entry unrecoverable).
            savedPaths = [as_str(as_dict(a).get('savedPath'), '') for a in atts]
            savedPaths = [p for p in savedPaths if p]
            attrParts = []
            if queuedAt:
                attrParts.append(f'timestamp="{queuedAt}"')
            if savedPaths:
                attrParts.append(f'attachments="{", ".join(savedPaths)}"')
            elif attachmentCount:
                attrParts.append(f'attachments="{attachmentCount}"')
            attrStr = ' ' + ' '.join(attrParts) if attrParts else ''
            parts.append(f'<queued_message{attrStr}>')
            parts.append(text)
            parts.append('</queued_message>')
            parts.append('')
    # The whole composite is queue-drain plumbing (it may embed steer notes
    # and [SUBAGENT RESULTS …] receipts) — one provenance value covers it for
    # mining and persist trimming; the audit's subagent_results kind is kept
    # in the vocabulary for any future pure-receipt row.
    return {
        'role': 'user',
        'source': SOURCE_QUEUED_USER,
        'content': '\n'.join(parts).strip(),
    }


def enqueueUserMessage(
    sessionId: str,
    text: str,
    attachments: list[dict[str, object]] | None = None,
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
        # _sessions is a 60-slot recency window — a background
        # subagent's parent can legitimately fall out of it; reload from the
        # durable store instead of silently dropping the completion notice.
        session = getWorkbenchSession(sessionId)
    if not session:
        return None
    if not hasattr(session, 'queuedUserMessages') or session.queuedUserMessages is None:
        session.queuedUserMessages = []
    kind_n = (kind or 'queue').strip().lower()
    # 'daemon' must be a storable kind: daemon_manager enqueues its completion
    # notices with it, and the subagent auto-turn drains with
    # kinds={'subagent','daemon'} (routers/workbench.py:274). Coercing it to
    # 'queue' here made that drain filter permanently unsatisfiable, so a
    # daemon notification could never wake its session — the whole daemon
    # auto-turn path was dead while every call site looked correct.
    if kind_n not in ('queue', 'steer', 'subagent', 'daemon'):
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
    # Hard cap with drop-oldest — the queue is unbounded
    # otherwise, and a model that keeps spawning subagents grows it every
    # completion (each _enqueue_completion lands here as kind='subagent').
    MAX_QUEUE_ENTRIES = 50
    if len(session.queuedUserMessages) >= MAX_QUEUE_ENTRIES:
        dropped = session.queuedUserMessages.pop(0)
        logger.warning(
            'workbench queue cap (%d) reached for %s — dropping oldest entry %s',
            MAX_QUEUE_ENTRIES,
            sessionId,
            dropped.get('id'),
        )
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


def _codeModeCellDenial(session: WorkbenchSession) -> str | None:
    """Parent trust/guard/approval gate for ONE model-authored code cell.

    Code mode is the widest execution surface in the product (a raw Python
    interpreter plus a bridge into every managed tool), so a cell may only
    run when ALL of the following hold — checked HERE, in the parent, before
    either the warm or the cold path executes anything:

      1. the session is in code mode AND the user explicitly enabled it
         (``code_runner.TRUST_METADATA_KEY``). A model can no longer grant
         itself the mode: ``set_agent_mode("code")`` must clear the
         ApprovalBanner door first (``code_mode_switch_decision``). A session
         persisted in code mode by an older build carries no marker and is
         refused until the user re-picks Code mode in the composer.
      2. the sandbox is not read-only — an interpreter is not a read.
      3. the ordinary guard axis (``_checkToolGuard``) allows the equivalent
         ``run_command`` — so plan mode blocks, and ask/edit queue the same
         permission prompt any other shell mutation gets.
      4. the durable approval axis (``_resolveCommandApproval``) allows it.

    Returns a receipt to hand back to the model, or None when the cell may
    run. Warm and cold both call this, so neither is a way around it;
    ``bridge_call`` keeps its own per-tool re-checks on top.
    """
    from app.services.workbench import code_runner as _code

    if as_str(getattr(session, 'agent_mode', '') or '').strip().lower() != 'code':
        return (
            '[code-mode] Blocked: this session is not in code mode, so the ```python '
            'block was not executed. Use tool calls instead.'
        )
    if not _code.is_code_mode_trusted(session):
        return (
            '[code-mode] Blocked: code mode is not enabled for this session. Only the '
            'user can enable it (composer → Code mode), and the ```python block was not '
            'executed. Ask them to switch this chat to Code mode, or use tool calls.'
        )
    sandbox_mode = as_str(getattr(session, 'sandboxMode', '') or '').strip().lower()
    if sandbox_mode in ('read-only', 'readonly', 'read'):
        return (
            '[code-mode] Blocked: the session sandbox is read-only, so no Python cell '
            'was executed. Use the read-only tools, or ask the user to switch the '
            'sandbox to Workspace / Full access.'
        )
    args: dict[str, object] = {
        'command': _code.cell_policy_command(),
        'timeout': _CODE_RUN_TIMEOUT_S,
    }
    pending_before = len(session.pendingMutations)
    blocked = _checkToolGuard(session, 'run_command', args)
    if blocked:
        _labelCodeCellMutation(session, pending_before)
        return f'[code-mode] Blocked: {blocked}'
    receipt = _resolveCommandApproval(session, 'run_command', args)
    if receipt:
        _labelCodeCellMutation(session, pending_before)
        return receipt
    return None


def _labelCodeCellMutation(session: WorkbenchSession, pending_before: int) -> None:
    """Give a freshly queued code-cell approval a human preview.

    The gate runs the axes with a fixed-shape command (see
    ``code_runner.cell_policy_command``) so once / this-chat / always grants
    cover every later cell; the banner text must therefore spell out what is
    being approved instead of echoing that placeholder.
    """
    from app.services.workbench import code_runner as _code

    for pm in session.pendingMutations[max(0, pending_before) :]:
        if not isinstance(pm, dict):
            continue
        if as_str(pm.get('toolName')) != 'run_command':
            continue
        if as_str(as_dict(pm.get('args')).get('command')) != _code.cell_policy_command():
            continue
        pm['preview'] = (
            'Run a code-mode cell: August executes the model\'s fenced ```python '
            'block locally (workspace-bound file access + shell inside the sandbox).'
        )


async def _runFencedCodeBlock(session: WorkbenchSession, text: str, toolRound: int) -> str | None:
    """Execute the model's fenced ```python block in code mode.

    Extracts the last fenced block, prepends the workspace-bound tool API,
    writes it under ``<workspace>/.aug/code_runs/`` and runs it through the
    existing sandboxed ``run_command`` machinery (same policy / approvals as
    any shell command). Returns None when the text has no fenced block.

    T13: cells in the same session run strictly sequentially (a per-session
    lock); the child gets a one-shot tool-bridge token + a kernel dir for
    persistent variables, and uses the pre-seeded venv interpreter if one is
    provisioned for the workspace.
    """
    from app.services.workbench import kernel as _kernel

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
        # Trust boundary: the parent decides whether a cell may run AT ALL
        # before the warm branch or the cold spawn is reached — neither path
        # executes anything (not even the interpreter boot) until this passes.
        denial = _codeModeCellDenial(session)
        if denial:
            return denial
        ws = as_str(getattr(session, 'workspacePath', '') or '')
        sandbox_mode = as_str(getattr(session, 'sandboxMode', '') or '')

        def _bridgeUrl() -> str:
            try:
                from app.config import settings as _settings

                return f'http://127.0.0.1:{int(getattr(_settings, "port", 8085))}/api/workbench/code-bridge'
            except Exception:
                return ''

        def _buildSource(token: str) -> str:
            return build_runner_source(
                block,
                ws,
                sandbox_mode=sandbox_mode,
                bridge_url=_bridgeUrl(),
                bridge_token=token,
                kernel_dir=_kernel.kernel_dir(ws, session.id),
            )

        def _formatCell(r) -> str:
            body = r.stdout or ''
            if r.stderr:
                body += (('\nSTDERR:\n' if body else '') + r.stderr)
            if r.exit_code != 0:
                body += f'{"" if not body else chr(10)}Exit code: {r.exit_code}'
            return format_result(body if body else '(no output)')

        # P3.2: prefer the WARM kernel — one persistent isolated
        # interpreter per session executing the SAME runner source the cold
        # path would spawn (guards inside the child; parent preflight runs
        # per cell so a mid-conversation sandbox change is honored). The cold
        # spawn remains the fallback (opt out via AUGUST_WARM_KERNEL_OFF=1).
        # T13's sequential guarantee covers the WARM path too — the session
        # lock is taken BEFORE the kernel branch (it used to wrap only the
        # cold spawn; concurrent warm cells could interleave stdin writes).
        #
        # SECURITY: the warm child is spawned directly and does NOT go
        # through the sandbox backends. While a strong backend (container,
        # AppContainer, seatbelt, bwrap) is active that would be a
        # hole — everything else confined, code mode wide open. So the warm
        # path is skipped and the cold spawn below runs the cell through
        # run_command, which IS sandboxed. Kernels already alive are killed
        # so a backend that turned on mid-session leaves none behind.
        lock = _kernel.session_kernel_lock(session.id)
        async with lock:
            try:
                from app.services.workbench import kernel as _kernel_mod

                warmOff = (os.environ.get('AUGUST_WARM_KERNEL_OFF', '').strip().lower()) in (
                    '1',
                    'true',
                    'yes',
                )
                warmAllowed, warmReason = _kernel_mod.warm_kernel_allowed()
                if not warmAllowed:
                    # A strong backend turned on (or could not be ruled out)
                    # after kernels were already booted — those children run
                    # unsandboxed, so none may outlive the decision. The cold
                    # path below still serves this cell, sandboxed.
                    if _kernel_mod.shutdown_warm_kernels():
                        logger.info(
                            'warm code kernels stopped: %s', warmReason
                        )
                if not (warmOff or not warmAllowed):
                    denial = _kernel_mod.preflight_warm_cell(sandbox_mode or None, ws or None)
                    if denial:
                        return f'[sandbox:soft] Blocked: {denial}'
                    interpreter = _kernel.venv_python(ws) or ''
                    wk = _kernel_mod.acquire_warm_kernel(ws, session.id, interpreter)
                    token = _kernel.issue_bridge_token(session.id)
                    try:
                        cell = await wk.run_cell_source(_buildSource(token), timeout=float(_CODE_RUN_TIMEOUT_S))
                    finally:
                        _kernel.revoke_bridge_token(token)
                    return _formatCell(cell)
            except Exception:
                logger.debug('warm code run failed — falling back to cold spawn', exc_info=True)

            # Cold spawn path (pre-P3.2 behavior), strictly sequential per session.
            _run_dir, path = runner_path(ws, session.id, toolRound)
            kernel_directory = _kernel.kernel_dir(ws, session.id)
            bridge_token = _kernel.issue_bridge_token(session.id)
            try:
                with open(path, 'w', encoding='utf-8') as f:
                    # The session's sandbox mode is rendered into the runner
                    # preamble (read-only denies write_file/run_command inside
                    # the child); bridge + kernel dir wire T13.
                    f.write(
                        build_runner_source(
                            block,
                            ws,
                            sandbox_mode=sandbox_mode,
                            bridge_url=_bridgeUrl(),
                            bridge_token=bridge_token,
                            kernel_dir=kernel_directory,
                        )
                    )
                interpreter = _kernel.venv_python(ws) or ''
                result = await _executeTool(
                    'run_command',
                    {'command': runner_command(path, interpreter), 'timeout': _CODE_RUN_TIMEOUT_S},
                    session,
                )
                return format_result(result)
            finally:
                _kernel.revoke_bridge_token(bridge_token)
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
    wait: bool = True,
) -> None:
    """The primary streaming entry point for workbench chat.

    This is the main chat loop that:
    1. Gets or creates the session
    2. Appends the user message
    3. Resolves provider/model
    4. Calls the model's streaming endpoint
    5. Handles tool calls in a loop
    6. Emits events for the SSE stream

    Serialized per session (Part 26 3.1): with ``wait=True`` (default) a
    second caller queues behind the live turn; with ``wait=False`` it raises
    ``SessionBusyError`` instead of overlapping it.
    """
    try:
        from app.services.harness_ops import touch_activity

        touch_activity()
    except Exception:
        pass
    if not sessionId:
        # Empty ids would funnel every bad caller onto one shared lock.
        raise ValueError('sendWorkbenchMessageStream: sessionId is required')
    # Perf tracing: spans/ring/logging need AUGUST_PERF_TIMING=1 (or a
    # forced outer trace); TTFT + tool-args-ready always record (persisted
    # turn telemetry).
    from app.lib.perf_timing import clear_current, current_trace, start_trace

    _owned_trace = False
    trace = current_trace()
    if trace is None:
        trace = start_trace('workbench_stream', sessionId=sessionId or '')
        _owned_trace = True
    from app.lib.batched_emit import BatchedEmit

    _batched: BatchedEmit | None = None
    if emit is not None:
        # 64 chars ≈ a few words per SSE event: fine enough for the client's
        # smooth character reveal (256 merged whole sentences → visible
        # bursts). First-token flush behavior is unchanged.
        _batched = BatchedEmit(
            emit,
            max_chars=64,
            on_first_content=trace.mark_ttft,
        )
        emit = _batched  # type: ignore[assignment]

    turnLock = _sessionTurnLock(sessionId)
    if not wait and turnLock.locked():
        raise SessionBusyError(sessionId)
    await turnLock.acquire()
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
        turnLock.release()
        if _batched is not None:
            _batched.flush()
        if _owned_trace:
            trace.finish()
            clear_current()


def _turnBaselineSnapshotTask(session_id: str, workspace: str, message: str) -> asyncio.Future:
    """Schedule the blocking shadow-git snapshot on a worker thread.

    Returns a Future resolving to the snapshot sha (or ''). The snapshot is
    4+ blocking ``subprocess.run`` git calls (measured 6.1 s first-turn on a
    large dirty repo) — off the loop, the model call can start while it runs.
    """
    loop = asyncio.get_running_loop()

    def _snap() -> str:
        try:
            from app.services.workbench import shadow_git as _shadow_git

            return _shadow_git.commit_snapshot(session_id, workspace, message) or ''
        except Exception:
            return ''

    return loop.run_in_executor(None, _snap)


async def _scheduleTurnBaselineSnapshot(session_id: str, workspace: str, message: str) -> asyncio.Future | None:
    """Turn-start entry: fire the off-loop snapshot without awaiting it.

    The returned Future is awaited lazily at the first-mutation boundary —
    the snapshot only has to complete before the turn's first WRITE.
    """
    return _turnBaselineSnapshotTask(session_id, workspace, message)




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
    # 1.1: the text-tool-protocol flag was set-true-only, so a session
    # that once ran a text-surface model (or hit the 2-refusal downgrade) kept
    # emitting the <tool_protocol> block + [TOOLCALL] parsing on later turns
    # even after switching to a native-tools model. Recompute per turn: the
    # tool-def build sets it True only for a text surface; the mid-turn
    # downgrade still sets it for the remainder of THIS turn.
    setattr(session, '_text_tool_protocol', False)
    _emitSessionStatus(sessionId)
    # Fresh per-turn remember budget (Bug 8b): the model may save at most
    # _REMEMBER_PER_TURN_LIMIT facts this turn.
    try:
        from app.services.tool_registrations.session_tools import reset_remember_turn_budget

        reset_remember_turn_budget(sessionId)
    except Exception:
        pass
    # /circuit gate: when the user invokes the circuit workbench, flip the
    # session flag and short-circuit the turn with an ack (the model is not
    # called for the command itself; the NEXT user message works in circuit
    # mode). Emits a `circuitMode` SSE event so the desktop pops the panel.
    try:
        from app.services.tool_registrations.circuit_tools import maybe_intercept_circuit

        interception = maybe_intercept_circuit(session, message)
    except Exception:
        interception = None
    if interception is not None:
        notice = as_str(interception.get('notice'), '')
        if emit:
            emit(
                {
                    'type': 'circuitMode',
                    'active': bool(interception.get('circuitMode')),
                    'message': notice,
                    'sessionId': sessionId,
                }
            )
            emit({'type': 'done', 'sessionId': sessionId})
        session.status = 'idle'
        saveSessions(dirty=session.id)
        return
    session.messages.append({'role': 'user', 'content': message})
    session.messageCount += 1
    # T16(a): a new user message resets within-run loop reminders; the past
    # turn's calls stay known so cross-turn repeats get nudged, then broken.
    try:
        tracker = getattr(session, '_tool_tracker', None)
        if tracker is not None:
            tracker.record_user_message()
    except Exception:
        logger.debug('tool tracker user-message reset failed', exc_info=True)
    # M7 item 1: immediate snippet title — the FIRST user message renames the
    # 'New chat' placeholder synchronously instead of waiting for turn end.
    # Slash commands derive no snippet, so they keep the placeholder until
    # the LLM titler runs (schedule_auto_title_after_turn below), which may
    # also upgrade a snippet title once the first assistant reply lands.
    try:
        from app.services.workbench.sessions import (
            derive_title_from_message,
            is_placeholder_title,
            rename_workbench_session,
        )

        if is_placeholder_title(getattr(session, 'title', None)):
            _snippetTitle = derive_title_from_message(message)
            if _snippetTitle:
                rename_workbench_session(sessionId, _snippetTitle)
    except Exception:
        logger.warning('immediate snippet title failed for %s', sessionId, exc_info=True)
    effectiveEffort = resolveEffectiveEffort(effort or as_str(session.metadata.get('effort', '')), session)
    # Persist so later turns / BTW inherit the composer effort selection.
    session.metadata['effort'] = effectiveEffort
    # The model the user picked always wins — unless a chat role they configured
    # claims the turn on a condition they also chose (an image attached, plan
    # mode, max effort). With no chat role configured this is a no-op, so the
    # default path is unchanged; `chat_default`/`cortex` only fill a turn that
    # arrived with no pick at all. See model_fleet_service.chatRoleForTurn.
    from app.services.model_fleet_service import chatRoleForTurn as _fleetChatRole
    from app.services.workbench.image_parts import messageHasImage as _messageHasImage

    role, roleModel, roleProvider = _fleetChatRole(
        has_image=_messageHasImage(message),
        plan_mode=as_str(getattr(session, 'agent_mode', '') or '') in ('orchestrator', 'planner'),
        max_effort=effectiveEffort == 'max',
        explicit_model=model or '',
    )
    if role and roleModel:
        logger.info(
            'chat role routing: %s owns this turn (model=%s provider=%s)',
            role,
            roleModel,
            roleProvider or 'unconfigured',
        )
        model, modelProvider = roleModel, roleProvider
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
                        except asyncio.CancelledError:
                            # Session teardown cancelled this detached task:
                            # executeSubAgent's own CancelledError branch marks
                            # the job row; propagate instead of swallowing.
                            raise
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

                    _recurringTask = asyncio.create_task(_run_recurring_subagent())
                    # Register the handle at CREATION, not from inside the
                    # coroutine: a session delete landing before the task's
                    # first await (semaphore acquire in executeSubAgent's
                    # path) would otherwise leave it uncancellable (audit
                    # batch 2026-09-09).
                    try:
                        from app.services.workbench.subagent import register_recurring_task

                        register_recurring_task(session.id, _recurringTask)
                    except Exception:
                        logger.debug('recurring-task registration failed', exc_info=True)
                except Exception:
                    logger.debug('recurring-task subagent dispatch failed', exc_info=True)
    except Exception:
        logger.debug('recurring tasks check failed', exc_info=True)
    # Turn-scoped refusal/self-heal state (audit sweep): reset here — at the
    # TRUE turn start — instead of inside buildSystemPrompt, so stale
    # flags/counters can't leak across turns.
    setattr(session, '_refusal_count', 0)
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
        return text

    with _trace.span('prompt_build'):
        # Build tool defs once and pass into system prompt (no double conversion).
        # Part 26 1.2/Phase 8: only the wire format the resolved provider
        # actually speaks is built — both builders previously ran every turn
        # (each a registry walk + BM25 assembly over the transcript).
        isAnthropic = _isAnthropicProvider(resolvedProvider)
        isOpenai = _isOpenaiProvider(resolvedProvider)
        # Responses-format models previously fell into the
        # openai branch and got a chat-completions body at /responses.
        isOpenaiResponses = not isAnthropic and _isResponsesProvider(resolvedProvider)
        tools: list[dict[str, object]] = []
        openaiTools: list[dict[str, object]] = []
        if isAnthropic:
            tools = toolDefinitions(session)
        elif isOpenai or isOpenaiResponses:
            # Responses consumes the same function defs flattened at wire time
            # (_responses_tools) — build the OpenAI list once.
            openaiTools = openaiToolDefinitions(session)
        # buildSystemPrompt's name extraction handles both wire shapes — pass
        # whichever list the resolved format built so the intake manifest and
        # tool-gated prompt sections still render on the OpenAI path.
        systemText = _buildSystemText(session, tools if isAnthropic else openaiTools)

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
    # P3.1: trailing stream tail after the last tool call's args
    # arrived, for the LAST tooled round — the time early dispatch could
    # save. Snapshot-per-round above; persisted in turn telemetry below.
    _toolArgsTailMs = 0
    # Universal prompt-cache metrics (Anthropic cache_read/cache_creation vs
    # OpenAI-compatible prompt_cache_hit/miss) — surfaced in the context
    # ring so cache hit rate is visible per session.
    totalCacheHitTokens = 0
    totalCacheMissTokens = 0
    # D8: which model actually answered when a fallback/promotion switch
    # happened — surfaced in the done event as usedFallback.
    chainUsedAt: str | None = None
    # Context window is also needed by the reactive overflow reduction inside
    # the tool loop — resolve it once here (0 = unknown → reduction skips).
    contextWindow = 0
    try:
        from app.providers.clients.base import estimateTokens
        from app.services.workbench.context_compressor import (
            COMPACT_TRIGGER_RATIO,
            REPLAY_USER_BUDGET_BYTES,
            acquireCompactionLock,
            compressMessages,
            isFeatureEnabled,
            noteCompactionPhase,
            pruneToolOutputs,
            releaseCompactionLock,
        )

        if isFeatureEnabled():
            contextWindow = _resolveModelContextWindow(resolvedModel, resolvedProvider)
            originalTokens = estimateTokens(session.messages)
            ratio = originalTokens / contextWindow if contextWindow else 0.0
            if ratio >= 0.9:
                attentionPressure = 'critical'
            elif ratio >= COMPACT_TRIGGER_RATIO:
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
            # Tier (a) projection prune: old tool outputs are blanked
            # in the model-facing projection only — session.messages stays
            # untouched unless compaction below persists the reduced list.
            currentMessages = pruneToolOutputs(currentMessages)
            if _shouldAutoCompact(attentionPressure, turnsSinceCompaction, remainingTokens):
                if not acquireCompactionLock(session):
                    logger.info('workbench auto-compact skipped — compaction lock held session=%s', sessionId)
                else:
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
                    noteCompactionPhase(session, 'summary')
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
                        # Prune-then-compact: token-budgeted verbatim
                        # tail (retain 0.16 × window) + fixed handoff schema
                        # carrying the file ledger across compactions.
                        contextWindow=contextWindow or None,
                        goalHint=as_str(getattr(session, 'goal', '') or ''),
                        schema=summarizer is None,
                        # Replay the newest verbatim user turns
                        # right after the summary (the summary loses nuance
                        # the user already paid for — fewer recovery rounds).
                        replayUserBytes=REPLAY_USER_BUDGET_BYTES,
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
                                    'trigger': 'pre_turn',
                                }
                            )
                        _emitRecovery(emit, 'auto-compact', currentTurn, 'compacted', False)
                        logger.info(
                            'workbench auto-compact session=%s tokens=%d→%d ratio=%.2f window=%d',
                            sessionId,
                            originalTokens,
                            compressedTokens,
                            ratio,
                            contextWindow,
                        )
                    releaseCompactionLock(session)
        else:
            currentMessages = list(session.messages)
    except Exception:
        currentMessages = list(session.messages)
    # M3 memory injection + Tier-3 <relevant_skills> (M6 item 6):
    # BM25-retrieve the facts and skill descriptions relevant to the current
    # user message and append them to it — the tail of the turn context. Never
    # in the SYSTEM prompt (the provider prefix cache stays stable, Q14).
    # 5.4 honesty note: the tail-patched last-user message IS
    # persisted into history by the step-boundary barrier flush (it rides an
    # older message, so it stays cache-stable), but each turn re-injects a
    # FRESH tail on the current last-user message — the persisted copy of a
    # past turn's <session_state>/<memory> is stale context the model should
    # not trust. Trimming it at persist is the follow-up; the comment here used
    # to claim "never persisted", which was wrong.
    #
    # Sizes of these volatile tail blocks, reported on the contextPressure
    # event so the composer's context breakdown can show a measurement instead
    # of a guess. Initialized to zero BEFORE the best-effort injection below:
    # that block is wrapped in try/except, so a partial failure leaves some
    # names never bound, and reading them at emit time would raise into the
    # emit's own except and silently drop the whole meter.
    _contextSections = tailSectionSizes(None, None, None, None)
    # Same pre-bind rule: the injected-skill names (the <relevant_skills>
    # detail keys) feed the turn's credit-assignment row (migration 050) and
    # must stay bound even when the injection block fails early.
    _skillsInjectedNames: list[str] = []
    try:
        from app.services import session_scope as _session_scope
        from app.services.capabilities_prompt import render_relevant_skills
        from app.services.memory_store.fact_retrieval import (
            build_memory_block,
            build_profile_memory_block,
        )

        try:
            from app.services import brain_config_service as _bc

            # Per-turn <memory> recall block is gated by memoryAutoInject
            # (default off) — recall happens only when the model calls the
            # read tool, not automatically every turn.
            _memReadOn = bool(_bc.getRuntimeConfig().get('memoryAutoInject', False))
        except Exception:
            _memReadOn = False
        _lastUserIdx = next(
            (
                i
                for i in range(len(currentMessages) - 1, -1, -1)
                if isinstance(currentMessages[i], dict) and currentMessages[i].get('role') == 'user'
            ),
            None,
        )
        if _lastUserIdx is not None:
            _userMsg = currentMessages[_lastUserIdx]
            _userText = as_str(_userMsg.get('content'), '')
            # Phase D item 2: query expansion — the previous user
            # turn joins the facts query at half weight so follow-ups
            # ("and the second one?") still recall their antecedent fact.
            _priorTurn = ''
            for _pi in range(_lastUserIdx - 1, -1, -1):
                _pm2 = currentMessages[_pi]
                if isinstance(_pm2, dict) and _pm2.get('role') == 'user':
                    _priorTurn = as_str(_pm2.get('content'), '')
                    break
            # M-2: one scope resolution per turn feeds both the
            # facts corpus union and the skills catalogue (bot private root).
            _turnScope = _session_scope.resolve_scope(session)
            # With a non-home workspace the memory tail
            # also carries the project's md-file entries (tagged section).
            # Hoisted above the read gate so the skills block (which shares
            # the workspace scope) can't NameError when memory read is off.
            _wsForTail = session.workspacePath if session.workspacePath else ''
            if _memReadOn:
                _recalledRows: list[dict[str, object]] = []
                _memoryBlock, _injectedFacts = build_memory_block(
                    _userText,
                    workspace=_wsForTail,
                    recalled=_recalledRows,
                    prior_turn=_priorTurn,
                    # M-2: Bot home chats recall global ∪ own notes;
                    # every other session stays on the plain global corpus.
                    scope=_turnScope,
                )
                # Phase D item 4: recall metrics — one internal_state
                # counter row per turn (before/after instrument for every
                # retrieval change). Best-effort, never blocking.
                try:
                    from app.services.memory_store.kv import set_internal_state

                    _metrics = {
                        'globalFactsRecalled': sum(
                            1 for r in _recalledRows if r.get('scope') == 'global'
                        ),
                        'projectEntriesRecalled': sum(
                            1 for r in _recalledRows if r.get('scope') == 'project'
                        ),
                        'memoryBlockChars': len(_memoryBlock or ''),
                        'skillsBlockChars': 0,
                    }
                    set_internal_state(
                        'memory:recall:last_turn', json.dumps(_metrics)
                    )
                    try:
                        from app.services.memory_store.kv import get_internal_state

                        _totals = json.loads(
                            str(get_internal_state('memory:recall:totals') or '{}')
                        )
                        if isinstance(_totals, dict):
                            _totals['turns'] = int(_totals.get('turns') or 0) + 1
                            _totals['globalFactsRecalled'] = int(
                                _totals.get('globalFactsRecalled') or 0
                            ) + _metrics['globalFactsRecalled']
                            _totals['projectEntriesRecalled'] = int(
                                _totals.get('projectEntriesRecalled') or 0
                            ) + _metrics['projectEntriesRecalled']
                            set_internal_state(
                                'memory:recall:totals', json.dumps(_totals)
                            )
                    except Exception:
                        pass
                except Exception:
                    logger.debug('recall metrics write failed', exc_info=True)
                # The typed-but-unrendered recalledMemories
                # event — what memory this turn actually recalled, for the
                # transcript's recall chip. One event per turn, non-blocking.
                if emit and _recalledRows:
                    try:
                        emit(
                            {
                                'type': 'recalledMemories',
                                'sessionId': sessionId,
                                'memories': _recalledRows,
                            }
                        )
                    except Exception:
                        logger.debug('recalledMemories emit failed', exc_info=True)
            else:
                # The identity lane is not keyword recall, so it is not this
                # gate's decision: `memoryAutoInject` controls whether to fish
                # for facts matching this message, not whether August knows who
                # it is talking to. Emptying the block here is what made the
                # app read as amnesiac while the user's profile sat stored and
                # active. Same corpus, same scope rule, its own bounded budget;
                # no metrics row and no recall chip, because nothing was
                # retrieved by relevance.
                try:
                    _memoryBlock, _laneRows = build_profile_memory_block(scope=_turnScope)
                    # ``session._injected_facts`` is a list of (key, title)
                    # pairs, unpacked as such by the turn-end usage bump
                    # (turn_close.py). The lane returns full rows for the recall
                    # chip, so narrow them here rather than teach the consumer
                    # a second shape.
                    _injectedFacts = [
                        (str(r.get('key') or ''), str(r.get('title') or ''))
                        for r in _laneRows
                    ]
                except Exception:
                    logger.debug('profile lane failed', exc_info=True)
                    _memoryBlock, _injectedFacts = '', []
            try:
                _memWritesOn = bool(_bc.getRuntimeConfig().get('modelMemoryWrites', True))
            except Exception:
                _memWritesOn = True
            _skillsBlock, _skillsDetail = render_relevant_skills(
                _userText, _wsForTail or None, _session_scope.bot_agent_id(_turnScope)
            )
            _nudgeBlock = memory_nudge_block(session, _memWritesOn)
            # The workdir file map used to ride INSIDE <workspace> in the
            # system block. Its builder has a 120 s TTL by design (a bounded
            # walk + stat of the workspace on every prompt build is too
            # expensive), so any TTL expiry changed a byte inside the
            # prefix-cached system block and forced a cold re-read of the
            # whole system block + tools + history. Moving it to the per-turn
            # tail is what the reference harnesses do: Hermes pins its
            # workspace block per session, oh-my-pi keeps no workspace
            # snapshot in the prompt at all, and only a cached prefix that
            # never changes mid-session can actually be cached.
            _mapBlock = ''
            if _wsForTail:
                try:
                    from app.services.workbench.code_map import build_code_map

                    _codeMap = build_code_map(_wsForTail)
                    if _codeMap:
                        _mapBlock = '<workspace_map>\n' + _codeMap + '\n</workspace_map>'
                except Exception:
                    logger.debug('prompt: code map build failed', exc_info=True)
            # Per-turn <session_state> carries the volatile
            # session fields purged from the (now byte-stable) system prompt.
            _stateBlock = _sessionStateBlock(session)
            _tailBlocks = '\n\n'.join(
                b
                for b in (_memoryBlock, _skillsBlock, _mapBlock, _stateBlock, _nudgeBlock)
                if b
            )
            _contextSections = tailSectionSizes(
                _memoryBlock,
                _skillsBlock,
                _stateBlock,
                _nudgeBlock,
                _skillsDetail,
                _mapBlock,
            )
            if _tailBlocks:
                _patched = dict(_userMsg)
                _patched['content'] = f'{_userText}\n\n{_tailBlocks}'
                # Mark the patch so every persist path can strip
                # the volatile tail before it rides in history forever
                # (bloat + stale <session_state>/<memory_nudge> blocks the
                # model may trust + phantom "user_correction" episodes in the
                # miner, whose injection filter is prefix-only).
                # _tailFrom is the pre-tail content length — the boundary the
                # persist path trims at (save_workbench_session_sot). Both
                # marker keys are stripped from upstream bodies (see
                # AUGUST_MESSAGE_ONLY_KEYS in message_sources.py).
                _patched['_tailPatched'] = True
                _patched['_tailFrom'] = len(_userText)
                currentMessages[_lastUserIdx] = _patched
            # Audit D1: the detail keys ARE the injected skill names — they ride
            # the turn row so per-skill effect can be measured. Deliberately
            # NOT nested under `if _memoryBlock:`: the skills lane is rendered
            # independently of the memory lane, and memoryAutoInject is OFF by
            # default, so gating the credit on a non-empty memory block left
            # skills_injected permanently NULL — the skill-lift and
            # brain-config readers were learning from an empty population.
            if _skillsDetail:
                _skillsInjectedNames = list(_skillsDetail.keys())
            if _memoryBlock:
                session._injected_facts = _injectedFacts
    except Exception:
        logger.debug('M3 memory injection failed', exc_info=True)
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
                        # Byte sizes of the per-turn tail blocks, so the ring
                        # can show what skills/memory/state actually cost rather
                        # than a client-side guess (0 was previously reported as
                        # if the contributor had been measured and found empty).
                        'contextSections': _contextSections,
                    }
                )
        except Exception:
            logger.debug('contextPressure emit failed (non-fatal)', exc_info=True)
    toolRound = 0
    lastExecSig: tuple[str, int] | None = None
    stalledRounds = 0
    stallMessageSent = False
    # Canonical (name, arguments) signatures already called this turn — feeds
    # the novelty exemption in the stall check below.
    seenToolSigs: set[tuple[str, str]] = set()
    # (tool, target) call counts, so a polling loop on one subject is not
    # mistaken for progress just because it re-spells its arguments.
    targetUses: dict[tuple[str, str], int] = {}
    # Families already nudged about this turn — one warning per failure mode.
    familyNudged: set[str] = set()
    # Turn-scoped malformed-tool counter: accumulates ACROSS rounds (a reset
    # per round meant repeated malformed calls never triggered the downgrade).
    parseFailures = 0
    # Reversible surface downgrade (A6): the bare-surface fallback restores
    # itself after a few clean rounds — one burst of malformed calls must not
    # cripple the rest of the turn (web_search/browser may still be needed).
    surfaceDowngraded = False
    cleanRoundsSinceDowngrade = 0
    # Self-heal retries (narration/refusal reminders) don't
    # consume the round budget — bounded so a hopeless model still hits the
    # loop cap instead of narrating forever.
    _SELFHEAL_EXEMPT_ROUNDS = 4
    _selfHealRetries = 0
    # P0 replay-safety state. Turn-scoped, not round-scoped: a rescue that
    # re-invokes the model after a PREVIOUS round already showed text or ran
    # a tool is a blind replay of work the user can see. Feeds
    # `_replayVetoReason` at every request-changing rescue.
    _turnEmittedText = False
    _turnExecutedTool = False
    # A prose answer cut off by the output token limit gets a bounded
    # "continue exactly where you stopped" retry rather than being delivered
    # mid-word as if it were complete (audit finding 2026-09-15 #3).
    _MAX_LENGTH_CONTINUATIONS = 2
    _lengthContinuations = 0
    # Why the tool loop ended, reported on the turn_end event so a user report
    # of "it stopped after N commands" is one query instead of a code audit
    # (audit finding 2026-09-15 #8).
    turnEndReason = 'finished'
    # Set when the turn ends on an error path — the done-event block below
    # still runs (to flush usage/evidence), and routing evidence must record
    # ok=False for error turns, not a hardcoded win.
    turnError: str | None = None
    # M5 turn telemetry: wall-clock start of this turn (finally block writes
    # one structured turn_outcomes row with it).
    _turnStartMs = int(time.time() * 1000)
    managedToolLoopCap = _managedToolLoopCap()
    # Turn budget ladder (audit P1#12). `_budgetStep` counts rungs already
    # spent; `_budgetFinalFired` marks that the one tool-free round is spent
    # too, which is the signal to end the turn as reason='budget'.
    _budgetArms = _turnBudget()
    _budgetStep = 0
    _budgetFinalFired = False
    # Tracks WHICH authority narrowed the surface. The A6 clean-round restore
    # may reverse the reversible self-heal downgrade, but a budget narrowing is
    # a consequence of the operator's budget arms and must survive to the end
    # of the turn — sharing one flag let the restore undo it.
    budgetSurfaceNarrowed = False
    # Monotonic, not time.time(): a wall-clock adjustment mid-turn must not
    # make a long turn look short (or a short one look over budget).
    _turnStartMono = time.monotonic()
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
                # Terminal-event protocol: this early `return`
                # bypasses the post-loop persist block AND the `finally` that
                # emits `done` belongs to a different `try` — so emit the
                # terminal `done` here (matching the circuit/other early exits)
                # or the client waits forever on a stream that already errored.
                session.status = 'idle'
                session.updatedAt = _now()
                try:
                    saveSessions()
                except Exception:
                    logger.exception('workbench save_sessions failed after ceiling block')
                _emitSessionStatus(sessionId)
                if emit:
                    emit({'type': 'done', 'sessionId': sessionId})
                # This return exits BEFORE the turn's try/finally —
                # the ContextVar token must be reset here or the cancel signal
                # leaks onto every later turn in this session.
                current_subprocess_cancel.reset(_cancel_token)
                return
        except Exception:
            logger.debug('cost ceiling check failed', exc_info=True)
    # Baseline shadow-git snapshot at turn start — revert targets
    # need the state from BEFORE the turn's first mutation. The snapshot is
    # 4+ blocking git subprocesses (measured 6.1 s on a large dirty repo on
    # the FIRST turn, ~0.3-1 s after) — it must never run on the event loop.
    # Schedule it off-loop now; the snapshot only has to complete before the
    # turn's first WRITE, which the first-mutation boundary below awaits.
    _baselineSnapshotFut = None
    if getattr(session, 'workspacePath', ''):
        try:
            _baselineSnapshotFut = _turnBaselineSnapshotTask(
                session.id, session.workspacePath, f'turn {session.turnCount + 1} start'
            )
        except Exception:
            logger.debug('shadow-git turn baseline scheduling failed', exc_info=True)
    # The first MUTATING tool awaits the snapshot before executing (the
    # invariant: the baseline must capture pre-mutation state). Non-mutating
    # turns never pay the join — and the snapshot itself runs OFF the loop
    # while the model streams.
    session._pendingBaselineSnapshot = _baselineSnapshotFut  # type: ignore[attr-defined]
    # 5.2: these are config/fleet walks — hoisted out of the round
    # loop so they run once per turn, not once per round. `promotionUsed` moves
    # up too, so "promote to a larger-context model once" is genuinely once per
    # turn (it previously reset every round).
    retryPolicy = _modelRetryPolicy()
    chainModels = _chatFallbackChain()
    promotionModel, promotionProvider = _chatContextPromotion()
    promotionUsed = False
    # Audit D1 (migration 050): the turn's credit-assignment accumulators.
    # Families ride the per-round steering scan (the union of each round's
    # window covers every tool failure the steering ever saw); loaded skills
    # are collected by skill_service's turn-scoped list and drained by
    # turn_close. Both are once-per-turn, NOT per-round.
    turnErrorFamilies: set[str] = set()
    # Audit D4: world-delta accumulators for the stall detector (see
    # _recordWorldDelta) — paths the turn has touched, and the last error
    # family per (tool, target) so a clean retry counts as progress.
    worldPaths: set[str] = set()
    familyByTarget: dict[tuple[str, str], str] = {}
    roundWorldDelta = {"moved": False}
    # Runaway backstop state (roadmap #1). Counted on world delta alone, so
    # argument novelty cannot reset it. The thresholds are brain-config and
    # opt-in: 0/0 leaves the backstop off, which is what an operator who wants
    # a genuinely uncapped turn gets.
    _runawayNudgeRounds, _runawayStopRounds = _runawayBudget()
    runawayRounds = 0
    runawayNudgeSent = False
    try:
        from app.services.skill_service import begin_turn_skill_collection

        begin_turn_skill_collection()
    except Exception:
        logger.debug('turn skill collection open failed', exc_info=True)
    while True:
        toolRound += 1
        mutationsBeforeRound = getattr(session, 'mutationCount', 0)
        # Reactive prune-then-compact may shrink the surface once
        # per round on a context-overflow error; the flag keeps it from
        # ping-ponging against a surface that refuses to shrink.
        overflowReducedThisRound = False
        if managedToolLoopCap > 0 and toolRound > managedToolLoopCap:
            msg = (
                f'Tool loop exceeded maxWorkbenchToolLoops ({managedToolLoopCap}); '
                'stopping to avoid unbounded cost.'
            )
            logger.warning('workbench %s', msg)
            if emit:
                emit({'type': 'error', 'message': msg})
            turnError = turnError or msg
            turnEndReason = 'cap'
            break
        # The budget ladder's last rung already had its one tool-free round.
        if _budgetFinalFired:
            logger.info('workbench %s ended on turn budget after %d rounds', sessionId, toolRound)
            turnEndReason = 'budget'
            break
        # Turn budget ladder, rung by rung (audit P1#12). Checked once per
        # round: a breach spends ONE rung and reports it, so an over-budget
        # turn degrades in visible steps rather than being cut off mid-flight.
        if _budgetBreached(
            _budgetArms,
            spend_usd=_turnSpendUsd(resolvedModel, totalCacheHitTokens, totalCacheMissTokens, totalOutputTokens),
            # hit+miss is the whole prompt on every provider shape (Anthropic
            # excludes both from input_tokens) — adding input_tokens too would
            # double-count exactly the turns the cache made cheap.
            tokens=totalCacheHitTokens + totalCacheMissTokens + totalOutputTokens,
            elapsed_sec=time.monotonic() - _turnStartMono,
        ):
            _budgetStep = _nextBudgetStep(_budgetStep)
            _rung = _BUDGET_LADDER[_budgetStep - 1]
            if _rung == 'surface':
                # Always consume this rung, even when the surface is already
                # narrowed. The old test was `if _rung == 'surface' and not
                # surfaceDowngraded`, so a turn that had been narrowed for any
                # OTHER reason fell straight past compaction into the terminal
                # 'final' branch — the documented three-rung ladder collapsed to
                # one and the turn ended a round early.
                _alreadyNarrowed = bool(surfaceDowngraded)
                if not _alreadyNarrowed:
                    tools = [t for t in toolDefinitions(session) if _toolDefName(t) in _BARE_TOOL_ALLOW]
                    openaiTools = [
                        t for t in openaiToolDefinitions(session) if _toolDefName(t) in _BARE_TOOL_ALLOW
                    ]
                    surfaceDowngraded = True
                    budgetSurfaceNarrowed = True
                    cleanRoundsSinceDowngrade = 0
                    systemText = _buildSystemText(session, tools if isAnthropic else openaiTools)
                _emitRecovery(emit, 'budget', _budgetStep, 'degraded', True)
                if emit:
                    emit(
                        {
                            'type': 'warning',
                            'message': (
                                'Turn budget already narrowed the tool surface to the essential '
                                'set for the rest of this turn.'
                                if _alreadyNarrowed
                                else 'Turn budget reached — narrowing the tool surface to the '
                                'essential set for the rest of this turn.'
                            ),
                        }
                    )
            elif _rung == 'compaction':
                _budgetCompacted = await _budgetTriggeredCompaction(
                    session,
                    sessionId,
                    currentMessages,
                    contextWindow=contextWindow,
                    emit=emit,
                    resolvedProvider=resolvedProvider,
                    resolvedModel=resolvedModel,
                    currentTurn=getattr(session, 'turnCount', 0),
                )
                # The `compaction` frame is emitted by _budgetTriggeredCompaction
                # itself, tagged trigger='budget' (roadmap #5). Emitting it here
                # as well — which is what the trigger tag briefly did — published
                # two frames for one compaction.
                if _budgetCompacted:
                    currentMessages = _budgetCompacted
                _emitRecovery(emit, 'budget', _budgetStep, 'degraded', True)
                if emit:
                    emit(
                        {
                            'type': 'warning',
                            'message': 'Turn budget reached — compacting context to buy headroom.',
                        }
                    )
            else:  # 'final' — one tool-free answer, then the turn ends
                _budgetFinalFired = True
                turnEndReason = 'budget'
                systemText = f'{systemText}{_BUDGET_FINAL_DIRECTIVE}'
                _emitRecovery(emit, 'budget', _budgetStep, 'stopped', True)
                if emit:
                    emit(
                        {
                            'type': 'warning',
                            'message': (
                                'Turn budget spent — this round answers in text only, and the turn '
                                'ends after it.'
                            ),
                        }
                    )
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
                elif _assistant_round_is_novel(currentMessages, seenToolSigs, targetUses):
                    # Real exploration — new files read/searched or prose
                    # emitted — is progress even though phase/step is flat.
                    # Only repeated identical calls keep counting.
                    stalledRounds = 0
                elif roundWorldDelta["moved"]:
                    # Audit D4: the world moved last round even though the
                    # self-reports are flat — new paths touched, or a
                    # (tool, target) that was failing now returns clean.
                    # Self-report is a tie-breaker, not the arbiter. The flag
                    # holds the PREVIOUS round's executions (the check runs
                    # before this round's tools) and is cleared below.
                    stalledRounds = 0
                else:
                    stalledRounds += 1
                    if stalledRounds >= MAX_STALLED_ROUNDS and not stallMessageSent:
                        stallMessageSent = True
                        currentMessages.append(
                            {
                                'role': 'user',
                                'source': SOURCE_HARNESS_NUDGE,
                                'content': (
                                    f'[Proxy Self-Heal] {stalledRounds} tool rounds have elapsed without '
                                    'advancing your execution phase/step. Reflect on what is blocking '
                                    'you, record where you are with update_state(phase=..., step=...), '
                                    'then either take a different approach or finish with a final answer. '
                                    + _REMINDER_FOOTER
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
                        turnEndReason = 'stall-stop'
                        break
            # Runaway backstop. Deliberately OUTSIDE the stall check above and
            # deliberately NOT reset by argument novelty: the stall counter
            # treats a new call signature as progress, so a model that calls a
            # different tool with different arguments every round never stalls,
            # never nudges and never hard-stops. With MAX_MANAGED_TOOL_ROUNDS
            # uncapped and the budget ladder off by default, nothing else
            # bounded it short of overflowing the context window.
            #
            # The evidence is world delta alone — a path the turn had not
            # touched before, or a (tool, target) that was failing and now
            # returns clean. Neither argument variety nor a flat update_state
            # can move that flag, so this counts the thing the other guard
            # structurally cannot see.
            if _runawayStopRounds > 0 and toolRound >= MIN_ROUNDS_BEFORE_STALL_CHECK:
                if roundWorldDelta["moved"]:
                    runawayRounds = 0
                    runawayNudgeSent = False
                else:
                    runawayRounds += 1
                    if runawayRounds >= _runawayStopRounds:
                        msg = (
                            f'Stopped: {runawayRounds} tool rounds ran without the turn touching '
                            'anything new — no new path and no previously failing call recovered.'
                        )
                        logger.warning('workbench %s', msg)
                        _emitRecovery(emit, 'runaway', runawayRounds, 'stopped', True)
                        if emit:
                            emit({'type': 'error', 'message': msg})
                        turnError = turnError or msg
                        # Reuses 'stall-stop' rather than adding a reason: it IS
                        # the same class of stop, and the reason vocabulary is
                        # read by the frontend badge, the turn_outcomes column
                        # and the docs. A new token would have to be added to
                        # all three to say the same thing.
                        turnEndReason = 'stall-stop'
                        break
                    if _runawayNudgeRounds > 0 and runawayRounds >= _runawayNudgeRounds:
                        if not runawayNudgeSent:
                            runawayNudgeSent = True
                            _emitRecovery(emit, 'runaway', runawayRounds, 'nudged', True)
                            currentMessages.append(
                                {
                                    'role': 'user',
                                    'source': SOURCE_HARNESS_NUDGE,
                                    'content': (
                                        f'[Proxy Self-Heal] The last {runawayRounds} tool rounds each '
                                        'looked different but none of them changed anything: no new '
                                        'file was read, and nothing you retried started working. '
                                        'Varying the call without changing the world is a loop. Stop, '
                                        'say what you have established in one sentence with '
                                        'update_state(phase=..., step=...), then either do the thing '
                                        'that actually changes state or finish with your best answer '
                                        'now.'
                                        + _REMINDER_FOOTER
                                    ),
                                }
                            )
                            if emit:
                                emit(
                                    {
                                        'type': 'warning',
                                        'message': (
                                            'No world movement across many tool rounds despite varied '
                                            'calls — nudged the model to stop varying and act.'
                                        ),
                                    }
                                )
            # Audit D4: the stall check above has consumed the previous
            # round's world-delta; this round's executions now fill the flag
            # for the next check.
            roundWorldDelta["moved"] = False
            # Error-family steer: independent of the novelty check above, because
            # six *different* commands failing the same way are one problem and
            # would otherwise read as progress until the round cap eats the turn.
            # Advisory only — it never ends the turn and never gates an answer.
            turnErrorFamilies.update(_recent_error_families(currentMessages))
            for family, hits in _recent_error_families(currentMessages).items():
                if hits < _ERROR_FAMILY_STREAK or family in familyNudged:
                    continue
                familyNudged.add(family)
                currentMessages.append(
                    {
                        'role': 'user',
                        'source': SOURCE_HARNESS_NUDGE,
                        'content': (
                            f'[Proxy Self-Heal] The last {hits} tool results all failed as '
                            f'"{family}". Repeating the call unchanged will fail unchanged: '
                            f'{_ERROR_FAMILY_ADVICE.get(family, "change one variable or switch approach")}. '
                            + _REMINDER_FOOTER
                        ),
                    }
                )
                if emit:
                    emit(
                        {
                            'type': 'warning',
                            'message': (
                                f'{hits} tool rounds failed as {family} — steered the model to '
                                'change approach.'
                            ),
                        }
                    )
                break
        if _isCancelled():
            turnEndReason = 'interrupted'
            break
        if toolRound > 1:
            queued = drainQueuedMessages(sessionId, emit=emit)
            if queued:
                logger.debug('workbench round %d: injecting %d queued user message(s)', toolRound, len(queued))
                currentMessages.append(_formatQueuedMessagesAsUserTurn(queued))
                try:
                    tracker = getattr(session, '_tool_tracker', None)
                    if tracker is not None:
                        tracker.record_user_message()
                except Exception:
                    logger.debug('tool tracker user-message reset failed', exc_info=True)
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
        # retryPolicy / chainModels / promotionModel / promotionUsed are hoisted
        # above the round loop — computed once per turn.
        # Fallback chain + context promotion (surpass #3): after retries are
        # exhausted on the primary model, the turn continues on the next
        # configured chain model (or a larger-context sibling on overflow).
        for chainIndex in range(len(chainModels) + 1):
            if chainIndex > 0:
                # P0: walking the fallback chain re-asks the round on a
                # DIFFERENT model, against whatever the earlier rounds left
                # behind. If the turn already showed text or ran a tool,
                # that is a blind replay — surface the error instead.
                _chainVeto = _replayVetoReason(
                    'chain_fallback',
                    emitted_text=_turnEmittedText,
                    executed_tool=_turnExecutedTool,
                )
                if _chainVeto is not None:
                    logger.warning(
                        'workbench chain fallback refused — %s; surfacing the error', _chainVeto
                    )
                    break
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
                isOpenaiResponses = not isAnthropic and _isResponsesProvider(resolvedProvider)
                # The skipped builder ran for a different format — build the
                # missing list now so the chain model sees its full tool set.
                if isAnthropic and not tools:
                    tools = toolDefinitions(session)
                elif (isOpenai or isOpenaiResponses) and not openaiTools:
                    openaiTools = openaiToolDefinitions(session)
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
            # Tools-fallback bookkeeping: once per chain model.
            toolsFallbackUsed = False
            toolsFallbackMessages: list[dict[str, object]] | None = None
            # T18 barrier 1: durable flush before the model request is
            # dispatched — fail-closed: a flush failure aborts the turn
            # rather than letting trajectory state silently diverge.
            flushOk, flushErr = _flushSessionBarrier(
                session, _BARRIER_MODEL_DISPATCH, currentMessages
            )
            if not flushOk:
                msg = f'Session durability flush failed before model dispatch: {flushErr}'
                logger.error('workbench %s', msg)
                if emit:
                    emit(
                        {'type': 'error', 'message': msg, 'code': 'durability_flush_failed'}
                    )
                turnError = turnError or msg
                break
            for retryAttempt in range(retryPolicy['maxRetries'] + 1):
                _llmT0 = time.monotonic()
                # Stream text live: per-delta finalOutput/thinking events go
                # straight to the SSE log so the UI paints incrementally.
                # A retry rolls the partial attempt back via the `retrying`
                # event (the frontend clears its streaming buffer on it), so
                # a failed attempt cannot leave duplicate/garbled answers.
                # Non-text events (toolResult, warnings) pass through live too.

                # R-C idempotency: track whether THIS attempt
                # emitted any generated content. A retryable failure after
                # partial emission must not replay the completion — the
                # provider already generated (and may have billed) tokens.
                attemptEmittedContent = False
                # Narration reclassify: text-only flag — a round that streams
                # prose AND ends in tool_use had provisional narration, not
                # the final answer. The client demotes it to thinking on the
                # marker below (works even with thinking_enabled=False, where
                # no thinking events arrive to trigger the heuristic).
                attemptEmittedText = False

                def _attemptEmit(evt: dict[str, object]) -> None:
                    nonlocal attemptEmittedContent, attemptEmittedText, _turnEmittedText
                    if evt.get('type') in ('finalOutput', 'thinking'):
                        attemptEmittedContent = True
                    if evt.get('type') == 'finalOutput':
                        attemptEmittedText = True
                        # P0 replay veto: text that reached the user is
                        # turn-scoped, not attempt-scoped — a rescue in a
                        # LATER round must see it too.
                        _turnEmittedText = True
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
                    # Chat/code mode never executes tools, so the
                    # full tool array rode upstream for zero benefit — the
                    # dominant 500-aggravator on weak gateways. Ship none.
                    # The budget ladder's final rung is the same situation:
                    # that round is a text-only answer, so advertising tools
                    # would only invite calls the turn will not run.
                    _wireTools = tools
                    _wireOpenaiTools = openaiTools
                    if (
                        as_str(getattr(session, 'agent_mode', '') or '') in ('chat', 'code')
                        or _budgetFinalFired
                    ):
                        _wireTools = []
                        _wireOpenaiTools = []
                    _attemptMessages = currentMessages
                    if not toolsFallbackUsed:
                        # Multimodal turns: user messages that
                        # reference stored image attachments carry the image
                        # inline on the wire (storage keeps plain text).
                        try:
                            from app.services.workbench.image_parts import inline_image_parts

                            _attemptMessages = inline_image_parts(currentMessages)
                        except Exception:
                            logger.debug('image part inline failed', exc_info=True)
                    if toolsFallbackUsed:
                        # The stripped request — no tools array,
                        # tool-call history flattened to text.
                        _wireTools = []
                        _wireOpenaiTools = []
                        _attemptMessages = toolsFallbackMessages or currentMessages
                    if isAnthropic:
                        response = await _callAnthropicWorkbench(
                            _attemptMessages,
                            systemText,
                            resolvedModel,
                            _wireTools,
                            effectiveEffort,
                            provider=resolvedProvider,
                            emit=_attemptEmit,
                            thinking_enabled=thinking_enabled,
                        )
                    elif isOpenaiResponses:
                        # Native Responses wire format — the same
                        # flattened OpenAI function defs.
                        response = await _callResponsesWorkbench(
                            _attemptMessages,
                            systemText,
                            resolvedModel,
                            _wireOpenaiTools,
                            effectiveEffort,
                            provider=resolvedProvider,
                            emit=_attemptEmit,
                            thinking_enabled=thinking_enabled,
                        )
                    elif isOpenai:
                        response = await _callOpenaiWorkbench(
                            _attemptMessages,
                            systemText,
                            resolvedModel,
                            _wireOpenaiTools,
                            effectiveEffort,
                            provider=resolvedProvider,
                            emit=_attemptEmit,
                            thinking_enabled=thinking_enabled,
                        )
                    else:
                        response = {'error': f'Unknown provider format for {resolvedProvider}'}
                totalGenerationMs += (time.monotonic() - _llmT0) * 1000
                # P3.1: snapshot the trailing stream tail — the time
                # between the last tool call's arguments finishing (in-stream
                # mark) and the stream ending HERE. The perf mark PERSISTS
                # across rounds, so only a round whose response actually
                # carries tool calls may overwrite the turn's value — a
                # text-only final round would otherwise diff the stale mark
                # against its own stream end and inflate the measurement by
                # the whole final generation (audit finding 2026-08-31).
                _roundTooled = (
                    any(
                        isinstance(b, dict) and b.get('type') == 'tool_use'
                        for b in as_list(response.get('content', []), [])
                    )
                    if isAnthropic
                    else bool(as_list(response.get('tool_uses', []), []))
                )
                if _roundTooled and not response.get('error'):
                    try:
                        from app.lib.perf_timing import tool_args_ready_to_stream_end_ms as _tailMs

                        _toolArgsTailMs = _tailMs()
                    except Exception:
                        _toolArgsTailMs = 0
                    if attemptEmittedText and emit is not None:
                        # This round streamed prose AND called tools: the
                        # prose was provisional narration, not the answer.
                        # Tell the client to reclassify it to thinking —
                        # deterministic, unlike the old heuristic that only
                        # fired when a later thinking event happened to arrive.
                        emit({'type': 'narrationReclassify'})
                # Retry transient upstream failures (429 rate limits, 5xx, network)
                # instead of killing the turn — up to maxRetries, then surface the
                # error as before.
                if not _isRetryableModelError(response):
                    # Reactive prune-then-compact: a context
                    # overflow is deterministic for THIS surface, but a
                    # reduced surface is a different request — shrink once
                    # per round and retry only if the token count actually
                    # dropped ("the surface advanced"). Otherwise fall
                    # through to context promotion / the fallback chain.
                    if (
                        _isContextOverflowError(response)
                        and not overflowReducedThisRound
                        and not _isCancelled()
                        and not attemptEmittedContent
                        and retryAttempt < retryPolicy['maxRetries']
                    ):
                        overflowReducedThisRound = True
                        _messagesBeforeReactive = len(currentMessages)
                        _tokensBeforeReactive = estimateTokens(currentMessages)
                        reduced = await _reactiveContextReduction(currentMessages, contextWindow, session)
                        if reduced is not None:
                            from app.providers.clients.base import estimateTokens as _estTok

                            beforeTokens = _tokensBeforeReactive
                            currentMessages = reduced
                            afterTokens = _estTok(currentMessages)
                            logger.warning(
                                'workbench context overflow — reduced surface %d→%d tokens, retrying',
                                beforeTokens,
                                afterTokens,
                            )
                            if emit:
                                emit(
                                    {
                                        'type': 'warning',
                                        'message': (
                                            f'Context overflow — reduced context {beforeTokens}→{afterTokens} '
                                            'tokens and retrying.'
                                        ),
                                    }
                                )
                            _emitRecovery(emit, 'context-reduction', 1, 'reduced', False)
                            # Roadmap #5: the success signal this item asked
                            # for — an overflow-triggered compaction that is
                            # countable in the same stream the pre-turn path
                            # already used.
                            _emitCompactionEvent(
                                emit,
                                trigger='reactive_overflow',
                                original_tokens=beforeTokens,
                                original_messages=_messagesBeforeReactive,
                                current_messages=currentMessages,
                                context_window=contextWindow,
                            )
                            continue
                        # The rescue RAN and achieved nothing — the threshold it
                        # compares against (`before - 1`, i.e. "shrink by one
                        # token") was not met. Roadmap #5: this used to be
                        # invisible, because the only signal was a `recovery`
                        # frame with no counts, so a reactive reduction that
                        # bought nothing was indistinguishable from one that
                        # never ran.
                        _emitCompactionEvent(
                            emit,
                            trigger='reactive_overflow',
                            original_tokens=_tokensBeforeReactive,
                            original_messages=_messagesBeforeReactive,
                            current_messages=currentMessages,
                            context_window=contextWindow,
                        )
                        _emitRecovery(emit, 'context-reduction', 1, 'failed', True)
                    break
                if retryAttempt >= retryPolicy['maxRetries'] or _isCancelled():
                    break
                if _retryBlockedByPartialEmission(response, attemptEmittedContent):
                    # R-C: the attempt already streamed generated tokens to
                    # the user; replaying it would pay for the same
                    # completion twice. Surface the error, keep the partial
                    # text (no `retrying` rollback event).
                    logger.warning(
                        'workbench model call failed after partial emission — not retrying '
                        '(replay could double-bill): %s',
                        as_str(response.get('error')),
                    )
                    break
                # Tools-fallback — a gateway that rejects the
                # request WITH tools (deterministic 500s, or any >=500 that
                # survives its own retries) will reject every identical
                # retry too. Retry ONCE per chain model with tools stripped
                # and tool history flattened before burning the remaining
                # identical-body attempts.
                errStatus = response.get('errorStatus')
                _statusInt = errStatus if isinstance(errStatus, int) else None
                _isQuotaLike = _statusInt in _QUOTA_STATUSES or any(
                    m in as_str(response.get('error'), '').lower() for m in _QUOTA_MARKERS
                )
                _isDeterministic400 = _statusInt == 400 and any(
                    m in as_str(response.get('error'), '').lower()
                    for m in _DETERMINISTIC_400_MARKERS
                )
                _hasToolsNow = bool(_wireTools or _wireOpenaiTools)
                # P0: the tools-fallback rewrites history (drops tool_calls,
                # flattens receipts) and re-asks as plain text. Once the
                # turn has side effects that is a blind replay, not a
                # rescue — the model would re-plan the same work.
                _toolsFallbackVeto = _replayVetoReason(
                    'tools_fallback',
                    emitted_text=_turnEmittedText,
                    executed_tool=_turnExecutedTool,
                )
                if (
                    retryPolicy.get('toolsFallback', 1)
                    and not toolsFallbackUsed
                    and _hasToolsNow
                    and not attemptEmittedContent
                    and _toolsFallbackVeto is None
                    and not _isCancelled()
                    and not _isQuotaLike
                    and not _isDeterministic400
                    and (_statusInt is not None and _statusInt >= 500 or not _statusInt)
                ):
                    toolsFallbackUsed = True
                    toolsFallbackMessages = _stripToolsFromHistory(currentMessages)
                    logger.warning(
                        'workbench upstream rejected the request with tools (%s) — retrying once without tools',
                        as_str(response.get('error'))[:200],
                    )
                    if emit:
                        emit(
                            {
                                'type': 'warning',
                                'message': (
                                    'Upstream rejected the request with tools — retrying once '
                                    'without tools. If this keeps happening, set the model\'s '
                                    'wire tool surface to reduced/text in Model settings.'
                                ),
                            }
                        )
                    continue
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
            # P0: promotion is a replay rescue — it re-asks the round on a
            # different model after the turn may already have shown text or
            # run a tool. Refuse once it has side effects.
            _promotionVeto = _replayVetoReason(
                'context_promotion',
                emitted_text=_turnEmittedText,
                executed_tool=_turnExecutedTool,
            )
            # Context promotion: overflow → larger-context sibling once,
            # before walking the normal fallback chain.
            if (
                not promotionUsed
                and promotionModel
                and _isContextOverflowError(response)
                and _promotionVeto is None
            ):
                pProvider, pModel = _resolveChatLlm(
                    model=promotionModel, model_provider=promotionProvider
                )
                if pProvider and pModel:
                    # Consume the one-shot promotion only on a
                    # successful resolve — a failed resolve must not burn it
                    # (the fallback chain may still carry a promotable sibling).
                    promotionUsed = True
                    resolvedProvider, resolvedModel = pProvider, pModel
                    # Same wire-format caveat as the fallback chain: the
                    # promoted model may be served on a different format.
                    isAnthropic = _isAnthropicProvider(resolvedProvider)
                    isOpenai = _isOpenaiProvider(resolvedProvider)
                    isOpenaiResponses = not isAnthropic and _isResponsesProvider(resolvedProvider)
                    if isAnthropic and not tools:
                        tools = toolDefinitions(session)
                    elif (isOpenai or isOpenaiResponses) and not openaiTools:
                        openaiTools = openaiToolDefinitions(session)
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
        if not isAnthropic and not isOpenai and not isOpenaiResponses:
            if emit:
                emit({'type': 'error', 'message': f'Unknown provider format for {resolvedProvider}'})
            turnError = turnError or f'Unknown provider format for {resolvedProvider}'
            break
        if turnError and not response:
            # Barrier-1 (durability flush) failure or unknown-format abort: the
            # model call never ran this round — bail before the usage/assistant
            # build below so no phantom empty assistant message is appended
            # and persisted.
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
            # point instead of wasting the round. Part 26 2.3: the self-heal
            # retry does NOT consume the round budget (bounded — after
            # _SELFHEAL_EXEMPT_ROUNDS retries the round counts normally, so a
            # model stuck narrating forever still hits the loop cap).
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
                    'source': SOURCE_HARNESS_NUDGE,
                    'content': (
                        '[Proxy Self-Heal] Stop narrating tool calls in prose. When you need a '
                        'tool, emit it as an actual tool call; do not describe it in text. '
                        'Continue with the task.'
                    ),
                }
            )
            # P0: the self-heal re-runs THIS round. The narration that
            # tripped the rule was already streamed to the user, and on a
            # later round a tool may have already moved the workspace —
            # re-asking is then a duplicate answer or a double-execution,
            # not a nudge. Let the narration ship instead.
            _selfHealVeto = _replayVetoReason(
                'self_heal',
                emitted_text=_turnEmittedText,
                executed_tool=_turnExecutedTool,
                text_vetoes=False,
            )
            if _selfHealVeto is not None:
                logger.warning('workbench narration self-heal refused — %s', _selfHealVeto)
                break
            if _selfHealRetries < _SELFHEAL_EXEMPT_ROUNDS:
                _selfHealRetries += 1
                toolRound -= 1
            continue
        respUsage = as_dict(response.get('usage'), {})
        if respUsage:
            totalInputTokens += as_int(respUsage.get('input_tokens', 0))
            totalOutputTokens += as_int(respUsage.get('output_tokens', 0))
            # Universal cache split — three provider shapes:
            #   • Anthropic: cache_read_input_tokens / cache_creation_input_tokens
            #     (input_tokens excludes both; uncached = input + creation).
            #   • DeepSeek: prompt_cache_hit/miss_tokens (disjoint sum).
            #   • OpenAI-compatible (OpenAI/OpenRouter/gateways):
            #     prompt_tokens_details.cached_tokens is a SUBSET of
            #     input_tokens → uncached = input − cached.
            inputNow = as_int(respUsage.get('input_tokens'), 0)
            creationNow = as_int(respUsage.get('cache_creation_input_tokens'), 0)
            hitNow: int | None = None
            missNow: int | None = None
            if respUsage.get('cache_read_input_tokens') is not None:
                hitNow = as_int(respUsage.get('cache_read_input_tokens'), 0)
                missNow = inputNow + creationNow
            elif respUsage.get('prompt_cache_hit_tokens') is not None:
                hitNow = as_int(respUsage.get('prompt_cache_hit_tokens'), 0)
                missExplicit = respUsage.get('prompt_cache_miss_tokens')
                missNow = (
                    as_int(missExplicit, 0) if missExplicit is not None else max(0, inputNow - hitNow)
                )
            elif respUsage.get('cached_tokens') is not None:
                # Aggregated-stream shape: providers.py preserves the
                # OpenAI-standard usage.prompt_tokens_details.cached_tokens
                # as a flat ``cached_tokens`` so gateways that only report
                # the details object still feed the cache split.
                hitNow = as_int(respUsage.get('cached_tokens'), 0)
                missNow = max(0, inputNow - hitNow)
            else:
                promptDetails = as_dict(respUsage.get('prompt_tokens_details'), {})
                cachedRaw = promptDetails.get('cached_tokens')
                if cachedRaw is not None:
                    hitNow = as_int(cachedRaw, 0)
                    missNow = max(0, inputNow - hitNow)
            if hitNow is not None:
                totalCacheHitTokens += hitNow
                totalCacheMissTokens += as_int(missNow, 0)
            else:
                # Provider reports no cache fields — the input was uncached.
                totalCacheMissTokens += inputNow
            # Persist the FULL prompt of the final sub-call, not the raw
            # `input_tokens`. On the Anthropic shape `input_tokens` excludes
            # both cache_read_input_tokens and cache_creation_input_tokens, so
            # recording it verbatim made a warm-cache session persist only its
            # uncached tail — the context ring then read a stable wrong "~10%"
            # while idle. missNow + hitNow is the whole prompt on every
            # provider shape the split above understands: Anthropic
            # (input+creation+read), DeepSeek (hit+miss, already disjoint),
            # OpenAI-compatible (input−cached+cached == input).
            finalContextTokens = (as_int(missNow, 0) if hitNow is not None else inputNow) + (
                hitNow or 0
            )
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
                    # P0: this round's "call" is the fenced block itself. It
                    # needs a real tool_use block to hang the receipt on —
                    # a bare tool message with a `code_<n>` id is an orphan
                    # tool_result, which strict gateways reject outright.
                    _codeId = f'code_{toolRound}'
                    _codeUse = {
                        'type': 'tool_use',
                        'id': _codeId,
                        'name': 'code_run',
                        'input': {'code': textContent[:2000]},
                    }
                    if isAnthropic:
                        contentVal = assistantMsg.get('content')
                        if not isinstance(contentVal, list):
                            contentVal = []
                        assistantMsg['content'] = [*contentVal, _codeUse]
                    else:
                        assistantMsg['tool_calls'] = [
                            {
                                'id': _codeId,
                                'type': 'function',
                                'function': {'name': 'code_run', 'arguments': '{}'},
                            }
                        ]
                    currentMessages.append(assistantMsg)
                    currentMessages.append(
                        _reconcileToolResults(
                            [(_codeId, 'code_run')],
                            [{'tool_use_id': _codeId, 'content': codeResult}],
                        ).results[0]
                    )
                    if emit:
                        emit(
                            {
                                'type': 'toolResult',
                                'id': _codeId,
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
                    currentMessages.append(
                        {
                            'role': 'user',
                            'source': SOURCE_HARNESS_NUDGE,
                            'content': reminder,
                        }
                    )
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
                    # The (bounded, ≤2) refusal reminder does not
                    # consume the round budget.
                    if _selfHealRetries < _SELFHEAL_EXEMPT_ROUNDS:
                        _selfHealRetries += 1
                        toolRound -= 1
                    continue
                logger.warning(
                    'workbench model refused tool use %d times; accepting the text answer',
                    refusalCount,
                )
            if textContent and stop_reason in ('max_tokens', 'length'):
                # Prose stopped on the output token limit with no tool call
                # attached. The tool-carrying case is handled below (fail-all +
                # retry receipt); until now this one just broke out and shipped
                # the half-sentence as the final answer (finding 2026-09-15 #3).
                if _lengthContinuations < _MAX_LENGTH_CONTINUATIONS:
                    _lengthContinuations += 1
                    logger.warning(
                        'workbench final text hit the output limit (stop_reason=%s, chars=%d) '
                        '— continuation %d/%d',
                        stop_reason,
                        len(textContent),
                        _lengthContinuations,
                        _MAX_LENGTH_CONTINUATIONS,
                    )
                    currentMessages.append(
                        {
                            'role': 'user',
                            'source': SOURCE_HARNESS_NUDGE,
                            'content': (
                                '[Proxy Self-Heal] Your last message was cut off by the '
                                'output token limit mid-sentence. Continue EXACTLY where it '
                                'stopped: output only the remaining text — no preamble, no '
                                'restating what you already said, no apology. If the missing '
                                'part was a tool call, emit that tool call now.'
                            ),
                        }
                    )
                    if emit:
                        emit(
                            {
                                'type': 'warning',
                                'message': (
                                    f'Answer hit the output token limit — asking the model '
                                    f'to continue ({_lengthContinuations}/'
                                    f'{_MAX_LENGTH_CONTINUATIONS}).'
                                ),
                            }
                        )
                    _emitRecovery(emit, 'length-continuation', _lengthContinuations, 'retrying', False)
                    continue
                # Budget spent and still truncated: say so instead of letting
                # the clipped text pass as a complete answer.
                turnEndReason = 'length'
                _emitRecovery(emit, 'length-continuation', _MAX_LENGTH_CONTINUATIONS, 'exhausted', True)
                logger.warning(
                    'workbench final text still truncated after %d continuations — '
                    'delivering the partial answer (stop_reason=%s)',
                    _MAX_LENGTH_CONTINUATIONS,
                    stop_reason,
                )
                if emit:
                    emit(
                        {
                            'type': 'warning',
                            'message': (
                                'The answer is still cut off at the output token limit after '
                                f'{_MAX_LENGTH_CONTINUATIONS} continuations — ask for the rest '
                                'in a follow-up message, or lower the thinking depth.'
                            ),
                        }
                    )
            queued = drainQueuedMessages(sessionId, emit=emit)
            if queued:
                logger.debug('workbench mid-response: injecting %d queued user message(s) after text turn', len(queued))
                currentMessages.append(_formatQueuedMessagesAsUserTurn(queued))
                try:
                    tracker = getattr(session, '_tool_tracker', None)
                    if tracker is not None:
                        tracker.record_user_message()
                except Exception:
                    logger.debug('tool tracker user-message reset failed', exc_info=True)
                continue
            break
        toolResults: list[dict[str, object]] = []
        planSubmittedThisRound = False
        clarifySubmittedThisRound = False
        pending_regular: list[tuple[str, dict[str, object], str]] = []
        invalidThisRound = 0
        # P0: the ordered (tool_use_id, tool_name) pairs this round actually
        # dispatched. `reconcile_tool_results` closes the round against this
        # list, so the assistant message's tool blocks and their results can
        # never drift apart — a missing result is synthesized, a duplicate or
        # orphan is dropped, on every exit path below. Building it also
        # repairs a tool block the model emitted without an id.
        callOrder: list[tuple[str, str]] = _canonicalToolCalls(
            toolUses, assistantMsg, is_anthropic=isAnthropic
        )
        # T2 length-stop fail-all: a generation that stopped on
        # the output token limit may carry half-parsed tool-call arguments —
        # executing them runs truncated commands/paths. Fail every call in
        # the batch unexecuted with a self-heal message; the model retries
        # with a smaller step. The thinking-only truncation case is handled
        # above; this is the tool-carrying complement.
        lengthStopReason = as_str(response.get('stop_reason') or response.get('finish_reason'))
        lengthStopFailAll = bool(toolUses) and lengthStopReason in ('max_tokens', 'length')
        if lengthStopFailAll:
            for tu in toolUses:
                tuName = as_str(tu.get('name', ''))
                tuId = as_str(tu.get('id', f'toolu_{uuid.uuid4().hex[:16]}'))
                if tuName:
                    calledTools.add(tuName)
                failMsg = (
                    f"[Validation Error] '{tuName or 'tool call'}' was NOT executed: this "
                    'generation stopped on the output token limit '
                    f'(stop_reason={lengthStopReason}), so its tool-call arguments may be '
                    'truncated. Do NOT stop — retry now with a smaller step: fewer tool '
                    'calls per message and shorter arguments.'
                )
                toolResults.append({'tool_use_id': tuId, 'role': 'tool', 'content': failMsg})
                if emit:
                    emit(
                        {
                            'type': 'toolResult',
                            'id': tuId,
                            'name': tuName,
                            'content': failMsg,
                            'status': 'error',
                            'durationMs': 0,
                            'startedAtMs': int(time.time() * 1000),
                            'blocked': True,
                        }
                    )
            if emit:
                emit(
                    {
                        'type': 'warning',
                        'message': (
                            f'Truncated generation (stop_reason={lengthStopReason}) — '
                            f'{len(toolUses)} tool call(s) failed unexecuted.'
                        ),
                    }
                )
        for tu in toolUses:
            if lengthStopFailAll:
                break
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
                PLANNER_ALLOWED_TOOLS,
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
                if parseFailures >= 3 and emit:
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
                # Re-inject the fresh state so this turn's later rounds see it.
                receipt = 'Plan submitted. Awaiting user approval.'
                stateBlock = _planStateBlock(session)
                if stateBlock:
                    receipt = receipt + '\n\n' + stateBlock
                if emit:
                    emit({'type': 'planProposed', 'plan': session.plan})
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': receipt,
                            'status': 'done',
                        }
                    )
                toolResults.append(
                    {'tool_use_id': toolUseId, 'role': 'tool', 'content': receipt}
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
                receipt = routeTodos(cast('list[dict[str, object]]', todosPayload), title=title, emit=emit)
                # Re-inject the fresh state so this turn's later rounds see it.
                stateBlock = _planStateBlock(session)
                if stateBlock:
                    receipt = receipt + '\n\n' + stateBlock
                if emit:
                    emit({'type': 'todosUpdated', 'todos': session.todos, 'title': title})
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': receipt,
                            'status': 'done',
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': receipt})
                continue
            if toolName in ('update_todos', 'updateTodos'):
                todosPayload = toolInput.get('todos') or toolInput.get('items') or toolInput
                if not isinstance(todosPayload, list):
                    todosPayload = [todosPayload] if todosPayload else []
                title = as_str(toolInput.get('title'), '')
                receipt = routeTodos(cast('list[dict[str, object]]', todosPayload), title=title, emit=emit)
                # Re-inject the fresh state so this turn's later rounds see it.
                stateBlock = _planStateBlock(session)
                if stateBlock:
                    receipt = receipt + '\n\n' + stateBlock
                if emit:
                    emit({'type': 'todosUpdated', 'todos': session.todos, 'title': title})
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': receipt,
                            'status': 'done',
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': receipt})
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
            # T5 approval axis (axis 2): independent of guard mode. Inert unless
            # the user enabled an approval policy; when active it may deny, ask
            # (queue an ApprovalBanner pending mutation), or let the command
            # through to the real sandbox (axis 1, still ground truth).
            approvalReceipt = _resolveCommandApproval(session, toolName, toolInput)
            if approvalReceipt:
                if emit:
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': approvalReceipt,
                            'error': approvalReceipt,
                            'status': 'blocked',
                            'durationMs': 0,
                            'startedAtMs': int(time.time() * 1000),
                            'blocked': True,
                        }
                    )
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': approvalReceipt})
                continue
            pending_regular.append((toolName, toolInput, toolUseId))
        # A user Stop mid-round leaves the round's tool calls without results —
        # the assistant message must not be persisted with dangling calls
        # (strict gateways reject tool_use/tool_calls that lack results).
        cancelledMidRound = _isCancelled()
        # Set when a mid-round cancel strips the assistant
        # message to empty — the append is skipped below.
        skipEmptyAssistantAppend = False
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
            # Read-before-edit gate: an edit on a file this session never
            # observed (or observed at a now-stale version) fails fast with a
            # distinct error code + remedy — before anything executes.
            gateError = _readBeforeEditGate(session, toolName, toolInput)
            if gateError:
                if emit:
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': gateError,
                            'status': 'error',
                            'durationMs': 0,
                            'startedAtMs': tool_started_at,
                        }
                    )
                return {'tool_use_id': toolUseId, 'role': 'tool', 'content': gateError}
            # T18 barrier 2: durable flush before a top-level tool body can
            # side-effect — fail-closed: the tool is skipped when the flush
            # fails. Nested calls (subagents, code runner) flush their own
            # sessions and reuse this outer checkpoint.
            flushOk, flushErr = _flushSessionBarrier(
                session, _BARRIER_TOOL_SIDE_EFFECT, currentMessages
            )
            if not flushOk:
                errMsg = (
                    f'Error: durability flush failed before {toolName} ({flushErr}) — '
                    'tool skipped to protect session integrity.'
                )
                logger.error('workbench %s', errMsg)
                if emit:
                    emit(
                        {
                            'type': 'toolResult',
                            'id': toolUseId,
                            'name': toolName,
                            'content': errMsg,
                            'status': 'error',
                            'durationMs': 0,
                            'startedAtMs': tool_started_at,
                        }
                    )
                return {'tool_use_id': toolUseId, 'role': 'tool', 'content': errMsg}
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
                    tracker.record_failure(toolName, toolInput)
                    # Learning signal: the episode miner + refine evidence
                    # read this table. Guardrails used to block invisibly.
                    from app.services.workbench.tool_guardrails import (
                        record_guardrail_block,
                    )

                    record_guardrail_block(session.id, toolName, guardMsg)
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
                                # Cumulative live-preview budget. Every chunk
                                # also lands in the durable event log (one
                                # tool_progress event each), so an uncapped
                                # stream let `npm install` write hundreds of
                                # events per command. Stop forwarding previews
                                # past the cap — the final toolResult still
                                # carries the full (SSE-truncated) output.
                                preview_budget = [100 * 1024]

                                async def _on_output(chunk: str) -> None:
                                    nonlocal last_emit
                                    if not emit or not chunk:
                                        return
                                    # Keep the idle-beat suppression honest
                                    # even once previews are capped: output
                                    # is still flowing, so no "Still working…".
                                    last_emit = time.monotonic()
                                    if preview_budget[0] <= 0:
                                        return
                                    sent = chunk[: preview_budget[0]]
                                    preview_budget[0] -= len(sent)
                                    if preview_budget[0] <= 0:
                                        sent += '\n[live preview capped at 100 KB — remaining output not streamed]\n'
                                    emit(
                                        {
                                            'type': 'tool_progress',
                                            'id': toolUseId,
                                            'name': toolName,
                                            'phase': 'running',
                                            'preview': sent,
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
                    if isinstance(result, str) and result.startswith('Error'):
                        tracker.record_failure(toolName, toolInput)
                    else:
                        # 1.3: a clean result advanced the task, so
                        # this call must not count as a cross-turn repeat.
                        tracker.record_success(toolName, toolInput)
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
            # Update_state changed plan/execution state mid-turn — the
            # <session_state> tail was built at turn start, so re-inject the
            # compact state block on the receipt to keep later rounds of this
            # same turn oriented.
            if toolName == 'update_state' and isinstance(result, str) and result.startswith('State updated'):
                stateBlock = _planStateBlock(session)
                if stateBlock:
                    result = result + '\n\n' + stateBlock
            # Audit D4: record what this call did to the world, so the stall
            # detector can credit real movement over self-report.
            if _recordWorldDelta(
                toolName, toolInput, result, world_paths=worldPaths, family_by_target=familyByTarget
            ):
                roundWorldDelta["moved"] = True
            # Record what this session just observed: a successful read
            # (single or bulk report) pins the file versions the model has
            # seen; a successful mutation FORGETS the version so the
            # follow-up edit is refused until the model re-reads what is
            # actually on disk.
            if isinstance(result, str):
                if toolName in ('read_file', 'read_files'):
                    _observeReadFile(session, toolName, toolInput, result)
                elif toolName == 'bulk':
                    # A bulk call is either a read op (pin the per-file
                    # versions its report shows) or a write op (forget the
                    # written files' versions); each helper no-ops on the
                    # other kind.
                    _observeReadFile(session, toolName, toolInput, result)
                    if not result.startswith('Error'):
                        _observeMutatedFile(session, toolName, toolInput)
                elif toolName in _GATED_EDIT_TOOLS and not result.startswith('Error'):
                    _observeMutatedFile(session, toolName, toolInput)
                    # Mutation log: the regular loop executes mutations
                    # directly (the approval path records its own), so the
                    # count/log must be kept here too — the per-step
                    # shadow-git snapshot below keys off this counter.
                    try:
                        recordMutation(session, toolName, toolInput, result)
                    except Exception:
                        logger.debug('mutation record failed', exc_info=True)
            # T1/T14 post-mutation hook: after a successful edit, run the
            # workspace lint/test gate and append the outcome to the receipt
            # so the model sees failures immediately (bounded fix loop; the
            # worktree-dedup gate skips re-runs when nothing changed).
            if (
                toolName in _EDIT_VERIFY_TOOLS
                and isinstance(result, str)
                and not result.startswith('Error')
            ):
                try:
                    verifyBlock = await _verifyAfterEdit(session, toolName, toolInput)
                except Exception:
                    logger.debug('post-edit verification hook failed', exc_info=True)
                    verifyBlock = ''
                if verifyBlock:
                    result = result + '\n\n' + verifyBlock
            # Exit-code surfacing: keep a lastCommand snapshot in session
            # metadata (name/command/exit code) so the UI and subagent
            # handoffs can show what ran most recently.
            if 'run_command' in toolName or toolName in ('bash', 'safe_python'):
                try:
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
                    logger.debug('last-command metadata record failed', exc_info=True)
            MAX_SSE_CONTENT = 100 * 1024
            sseTrimmed, contentTruncated = _truncateToolOutput(result, MAX_SSE_CONTENT)
            if contentTruncated:
                sseContent = (
                    sseTrimmed
                    + '\n\n[... Tool result truncated at 100 KB — full length: {} bytes]'.format(
                        len(result)
                    )
                )
            else:
                sseContent = result
            # Authoritative status for this round's receipt: the tool declares
            # failure at the START of its own text. Computed ONCE here from the
            # shared rule so the SSE frame and the durable transcript message
            # can never disagree (``tool_protocol.tool_result_failed``).
            toolStatus = 'error' if _toolResultFailed(str(result)) else 'done'
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
                        'status': toolStatus,
                        # Loud or quiet, decided from the same receipt the
                        # status came from — see tool_protocol.RECEIPT_TONE.
                        'tone': _receiptTone(str(result)),
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
                # Plan §4.3: activate the dormant memoryUpdated path — a
                # successful `remember` renders as a subtle in-chat chip.
                if toolName == 'remember':
                    try:
                        parsedMem = json.loads(result)
                    except Exception:
                        parsedMem = None
                    if isinstance(parsedMem, dict) and parsedMem.get('ok') is True:
                        label = as_str(toolInput.get('title') or '', '') or as_str(
                            toolInput.get('fact') or '', ''
                        )[:60]
                        verb = 'Updated memory' if parsedMem.get('updated') else 'Remembered'
                        emit(
                            {
                                'type': 'memoryUpdated',
                                'summary': (f'{verb}: {label}'.strip() if label else 'Memory updated'),
                                'key': as_str(parsedMem.get('key'), ''),
                            }
                        )
            # Truncate what the model sees next turn — SSE already truncates for the UI.
            # The cap is per-model when the capability profile sets one.
            historyContent = result
            # Stage B first: an oversized FRESH result
            # spills to a session file and is replaced by a head/tail preview
            # inside the 30 KB / 2000-line budget; the ordinary cap then
            # applies to whatever stage B left (or to smaller results).
            if isinstance(historyContent, str) and len(historyContent) > _SPILL_THRESHOLD_CHARS:
                # Whether the model can read the spill back is decided in
                # _canRetrieveSpill (module-level, and tested there) — it was
                # inline here, and read only the Anthropic-shaped `tools`
                # list, which is [] on the OpenAI/Responses wire. That made
                # canRetrieve False there, _spillToolResult returned None,
                # and oversized results were hard-truncated with no recovery
                # file on the formats most providers speak.
                spilled = _spillToolResult(
                    session,
                    toolName,
                    historyContent,
                    retrievable=_canRetrieveSpill(tools, openaiTools, session),
                )
                if spilled is not None:
                    historyContent = spilled
            resultCap = _toolResultCap(session)
            historyTrimmed, historyTruncated = _truncateToolOutput(historyContent, resultCap)
            if historyTruncated:
                historyContent = (
                    historyTrimmed
                    + f'\n\n[... Tool result truncated at {resultCap // 1024} KB '
                    + f'— full length: {len(result)} bytes]'
                )
            return {
                'tool_use_id': toolUseId,
                'role': 'tool',
                'content': historyContent,
                # The same verdict the UI was just told, now durable: this is
                # the message ``normalize_tool_result`` will carry into the
                # transcript, and the only thing episode mining reads.
                'is_error': toolStatus == 'error',
            }

        try:
            if pending_regular:
                # P0 replay veto: the batch is about to dispatch real tools,
                # so from here on a request-changing rescue would re-plan
                # against an already-mutated world.
                _turnExecutedTool = True
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
                    # Do NOT undo a BUDGET downgrade. The A6 restore is for the
                    # reversible self-heal downgrade (malformed tool JSON). It
                    # used to clear the same flag, so a turn that breached its
                    # budget recovered the FULL tool surface through rungs 2 and
                    # 3 and the documented bare-surface narrowing never held.
                    # The budget rung is re-asserted below when it owns the flag.
                    if budgetSurfaceNarrowed:
                        tools = [t for t in tools if _toolDefName(t) in _BARE_TOOL_ALLOW]
                        openaiTools = [
                            t for t in openaiTools if _toolDefName(t) in _BARE_TOOL_ALLOW
                        ]
                        surfaceDowngraded = True
                        cleanRoundsSinceDowngrade = 0
                    else:
                        cleanRoundsSinceDowngrade = 0
                    # The system prompt enumerates the offered
                    # tools — rebuild it so the restored surface is advertised
                    # (the old prompt listed the bare set only).
                    systemText = _buildSystemText(session, tools if isAnthropic else openaiTools)
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
                # Rebuild the system prompt — it still advertised
                # the full tool list, dead the moment the surface shrank.
                systemText = _buildSystemText(session, tools if isAnthropic else openaiTools)
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
        # P0 — the single normalization choke point, reached on EVERY
        # tool-call exit path. Everything that built a result above
        # (blocked/approval/plan receipts, the parallel stage, the
        # length-stop fail-all, malformed-arg self-heals) lands here and
        # only here, so the round closes with exactly one well-formed
        # result per dispatched call: missing → synthetic, duplicate →
        # collapsed, orphan → dropped. This must run BEFORE the
        # "no results" bail below — that path used to break out of the loop
        # while the assistant message still carried tool calls, and the
        # next turn then replayed a tool_use with no tool_result, which
        # Anthropic rejects as a NON-retryable 400 and which OpenAI
        # gateways silently mangle.
        _closed = _reconcileToolResults(callOrder, toolResults) if callOrder else None
        if _closed is not None:
            if _closed.synthesized or _closed.dropped:
                logger.warning(
                    'workbench tool-result reconciliation repaired round %d — '
                    'synthesized=%d dropped=%d',
                    toolRound,
                    len(_closed.synthesized),
                    len(_closed.dropped),
                )
                if emit:
                    emit(
                        {
                            'type': 'warning',
                            'message': (
                                f'{len(_closed.synthesized)} tool result(s) were missing and were '
                                'marked NOT executed; re-issue them if the work is still needed.'
                            ),
                        }
                    )
            toolResults = _closed.results
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
            # Part 26 2.4 / Part 27 T3: if stripping left NOTHING (the round was
            # pure tool calls), skip the append — an empty assistant bubble
            # breaks alternation and renders blank. The old guard only caught an
            # empty LIST (Anthropic), so a cancelled OpenAI round (empty string
            # content) slipped through. Shape-precise: empty list / empty string
            # / None skip; a list carrying tool_use blocks is kept.
            _ac = assistantMsg.get('content')
            _emptyContent = (
                _ac is None
                or (isinstance(_ac, list) and len(_ac) == 0)
                or (isinstance(_ac, str) and not _ac.strip())
            )
            if _emptyContent:
                skipEmptyAssistantAppend = True
        if not skipEmptyAssistantAppend:
            currentMessages.append(assistantMsg)
        # 0.4: on a mid-round cancel every tool_use block was just
        # stripped from the assistant message, so this round's tool_results are
        # all dangling — appending them yields a tool_result with no matching
        # tool_use, which Anthropic rejects as a NON-retryable 400 and bricks
        # the session on the next turn. Drop them with the calls they answered.
        # (`toolResults` is already the reconciled, exactly-one-per-call list
        # closed above.)
        if not cancelledMidRound:
            currentMessages.extend(toolResults)
        # T18 barrier 3: durable flush at the step boundary — the completed
        # round (assistant message + tool results) is now replay-safe.
        # Fail-closed: abort the loop rather than keep mutating state that
        # is no longer durably recorded.
        flushOk, flushErr = _flushSessionBarrier(
            session, _BARRIER_STEP_BOUNDARY, currentMessages
        )
        if not flushOk:
            msg = f'Session durability flush failed at step boundary: {flushErr}'
            logger.error('workbench %s', msg)
            if emit:
                emit({'type': 'error', 'message': msg, 'code': 'durability_flush_failed'})
            turnError = turnError or msg
            break
        # Per-step shadow-git snapshot — a round that ran mutating
        # tools commits the workspace state (rollback substrate + ChangesCard
        # diff source). Best-effort: a snapshot failure never breaks the turn.
        if getattr(session, 'mutationCount', 0) > mutationsBeforeRound and getattr(
            session, 'workspacePath', ''
        ):
            try:
                from app.services.workbench import shadow_git as _shadow_git

                def _stepSnap() -> None:
                    _shadow_git.commit_snapshot(
                        session.id,
                        session.workspacePath,
                        f'step {toolRound}: {session.mutationCount - mutationsBeforeRound} mutation(s)',
                    )

                # Off the event loop, exactly like the turn-start baseline
                # (_turnBaselineSnapshotTask). This ran inline, so every mutating
                # round blocked the loop for 4+ git subprocesses — and only the
                # mutex wait was bounded (_GIT_TIMEOUT_S), the subprocesses were
                # not. Awaited (not fire-and-forget) so successive per-step
                # snapshots keep their round order for the ChangesCard diff.
                await asyncio.get_running_loop().run_in_executor(None, _stepSnap)
            except Exception:
                logger.debug('shadow-git step snapshot failed', exc_info=True)
        if planSubmittedThisRound:
            turnEndReason = 'awaiting-input'
            break
        if clarifySubmittedThisRound:
            turnEndReason = 'awaiting-input'
            break
    await _tc.emitStopHook(sessionId, toolRound, turnError)
    # M3 usage feedback + M5 turn telemetry (turn_close.py). Runs after
    # the loop on every completed turn (error turns included — turnError is
    # final here); best-effort, never breaks the persist path below.
    _totals = _tc.TurnTotals(
        inputTokens=totalInputTokens,
        outputTokens=totalOutputTokens,
        contextTokens=finalContextTokens,
        generationMs=totalGenerationMs,
        cacheHitTokens=totalCacheHitTokens,
        cacheMissTokens=totalCacheMissTokens,
        toolArgsReadyMs=int(_toolArgsTailMs or 0),
    )
    await _tc.turnTelemetry(
        session=session,
        sessionId=sessionId,
        currentMessages=currentMessages,
        tools=tools,
        openaiTools=openaiTools,
        resolvedModel=resolvedModel,
        resolvedProvider=resolvedProvider,
        totals=_totals,
        turnStartMs=_turnStartMs,
        trace=_trace,
        turnError=turnError,
        emit=emit,
        toolRound=toolRound,
        turnEndReason=_finalTurnEndReason(
            turnEndReason, errored=turnError is not None, cancelledNow=_isCancelled()
        ),
        parseFailures=parseFailures,
        surfaceDowngraded=surfaceDowngraded,
        # Audit D1 (migration 050): credit assignment. skillsInjected comes
        # from the <relevant_skills> detail keys; errorFamilies from the
        # per-round steering scan union. skills_loaded and facts_injected
        # are drained inside turnTelemetry (it owns those authorities).
        skillsInjected=_skillsInjectedNames,
        errorFamilies=sorted(turnErrorFamilies),
    )
    try:
        logger.debug('workbench turn complete: %d rounds, in=%d out=%d', toolRound, totalInputTokens, totalOutputTokens)
        _tc.persistAndClose(
            session=session,
            sessionId=sessionId,
            currentMessages=currentMessages,
            resolvedModel=resolvedModel,
            totals=_totals,
            trace=_trace,
            emit=emit,
        )
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
                    'cacheHitTokens': totalCacheHitTokens,
                    'cacheMissTokens': totalCacheMissTokens,
                },
            }
            # D8: the message shows who actually answered when a
            # fallback/promotion switch happened mid-turn.
            if chainUsedAt:
                doneEvent['usedFallback'] = chainUsedAt
            # turn_end: WHY the loop stopped, with the round count. A report of
            # "it froze after 13 commands" used to take a code audit to answer;
            # now it is one line in the session event log (finding 2026-09-15
            # #8). A specific reason (cap / stall-stop / length / interrupted /
            # awaiting-input) outranks the generic 'error' even though those
            # paths also set turnError.
            _endReason = _finalTurnEndReason(
                turnEndReason, errored=turnError is not None, cancelledNow=_isCancelled()
            )
            emit(
                {
                    'type': 'turn_end',
                    'sessionId': sessionId,
                    'reason': _endReason,
                    'rounds': toolRound,
                    'error': turnError is not None,
                }
            )
            emit(doneEvent)
    _tc.scheduleAutoTitle(
        sessionId=sessionId,
        currentMessages=currentMessages,
        resolvedProvider=resolvedProvider,
        resolvedModel=resolvedModel,
    )


# Managed-tool dispatch lives in loop/exec.py (P1#11 split, HIGH RISK): the
# `_executeTool` dispatcher and its immediate private helpers moved VERBATIM,
# together with the two exec-only support symbols it reads (the
# AUGUST_TOOL_TIMEOUT_S constant and the baseline-snapshot join). Re-exported
# under the original names so the loop body, the grant API below and the
# tests that monkeypatch `wb._executeTool` keep resolving them here.
from app.services.workbench.loop.exec import (  # noqa: E402
    _TOOL_EXEC_TIMEOUT_S,  # noqa: F401 -- re-export: old name kept
    _awaitBaselineSnapshot,  # noqa: F401 -- re-export: old name kept
    _envTimeoutSeconds,  # noqa: F401 -- re-export: old name kept
    _executeTool,
    _get_tool_grants,
    _load_always_grants_for_workspace,  # noqa: F401 -- re-export: old name kept
    _mutation_categories,  # noqa: F401 -- re-export: old name kept
    _mutation_grant_key,  # noqa: F401 -- re-export: old name kept
    _mutation_preview,  # noqa: F401 -- re-export: old name kept
    _save_always_grant,  # noqa: F401 -- re-export: old name kept
    _set_tool_grants,  # noqa: F401 -- re-export: old name kept
)


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


def get_approval_policy_config() -> dict[str, object]:
    """The durable T5 approval policy (axis 2) for the Settings UI."""
    from app.services.workbench.permissions import policy_from_dict

    try:
        from app.services.config_service import getConfig

        cfg = getConfig() or {}
        raw = cfg.get('approvalPolicy')
    except Exception:
        raw = None
    return policy_from_dict(as_dict(raw) if raw is not None else None).to_dict()


def set_approval_policy_config(raw: dict[str, object] | None) -> dict[str, object]:
    """Validate + persist the durable T5 approval policy. Returns normalized form."""
    from app.services.workbench.permissions import policy_from_dict

    policy = policy_from_dict(as_dict(raw) if raw is not None else None)
    normalized = policy.to_dict()
    try:
        from app.services.config_service import getConfig, saveConfig

        cfg = getConfig() or {}
        cfg['approvalPolicy'] = normalized
        saveConfig(cfg)
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}
    return {'ok': True, 'policy': normalized}


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
    categories: list[str] | tuple[str, ...] | None = None,
) -> tuple[str, str]:
    """Record a user grant. scope: once | session | always.

    Returns the scope actually stored plus a note when the request was
    clamped, so the caller reports what happened instead of echoing what was
    asked (see app/services/workbench/grant_policy.py).

    ``categories`` is the permission-axis classification of this call. Callers
    that hold it (the pending-mutation path) pass it so an `always` on a
    destructive/network command is clamped here rather than only in the UI; when
    it is omitted the categories are recomputed from the args.
    """
    from app.services.workbench.grant_policy import effective_scope

    key = _mutation_grant_key(toolName, args)
    cats = list(categories) if categories is not None else _mutation_categories(
        toolName, args, session.workspacePath or ''
    )
    scope_n, clamp_note = effective_scope(key, scope, cats)
    if clamp_note:
        logger.warning('grant clamped for %s: %s', toolName, clamp_note)
    grants = _get_tool_grants(session)
    bucket = list(grants.get(scope_n) or [])
    if key not in bucket:
        bucket.append(key)
    grants[scope_n] = bucket
    _set_tool_grants(session, grants)
    if scope_n == 'always' and session.workspacePath:
        _save_always_grant(session.workspacePath, key)
    return scope_n, clamp_note


def _loadApprovalPolicy(session: WorkbenchSession) -> _ApprovalPolicy:
    """Load the T5 approval policy: session metadata overrides global config."""
    from app.services.workbench.permissions import policy_from_dict

    meta = as_dict(session.metadata) if session.metadata else {}
    if meta.get('approvalPolicy') is not None:
        return policy_from_dict(as_dict(meta.get('approvalPolicy')))
    try:
        from app.services.config_service import getConfig

        cfg = getConfig() or {}
        if cfg.get('approvalPolicy') is not None:
            return policy_from_dict(as_dict(cfg.get('approvalPolicy')))
    except Exception:
        logger.debug('approval policy config load failed', exc_info=True)
    return policy_from_dict(None)


def _approval_never_ask(
    policy: _ApprovalPolicy, session: WorkbenchSession | None = None
) -> bool:
    """Never-ask stance: headless/unattended runs must never hang on a prompt.

    S-1 rider (2026-09-04): the per-session ``headless`` flag is the primary
    signal — automation runs (``automations_store``) and gateway bridges stamp
    it at creation. Before the rider only the process-wide env var and the
    daemon context were consulted, so unattended routine runs silently used
    the interactive ask policy and soft-locked on desktop-only prompts.
    """
    if policy.never_ask:
        return True
    if session is not None and bool(getattr(session, 'headless', False)):
        return True
    if os.environ.get('AUGUST_HEADLESS', '').strip().lower() in ('1', 'true', 'yes'):
        return True
    try:
        from app.services.tool_registry import isDaemonContext

        if isDaemonContext():
            return True
    except Exception:
        pass
    return False


def _record_unattended_denial(
    session: WorkbenchSession, toolName: str, reason: str
) -> None:
    """Best-effort M-11 blocked-step ledger row for an unattended denial.

    Only automation runs carry ``automationJobId`` (stamped in
    ``automations_store._run_workbench_stream``); interactive and ad-hoc
    headless sessions record nothing. Never raises into the turn.
    """
    try:
        meta = as_dict(session.metadata) if session.metadata else {}
        job_id = as_str(meta.get('automationJobId'))
        if not job_id:
            return
        from app.services import automation_memory

        automation_memory.record_blocked_step(
            job_id=job_id, tool=toolName, reason=reason, session_id=session.id
        )
    except Exception:
        logger.debug('unattended denial ledger record failed', exc_info=True)


def _unattended_mutation_denial(toolName: str) -> str:
    """Deny receipt for a mutation-gate ask in an unattended run.

    Mirrors ``permissions.unattended_denial`` (the command-axis seam) for the
    guard-mode axis: the model gets a terminal answer now instead of a
    "waiting for approval" stall no human will ever clear.
    """
    return (
        f"Tool '{toolName}' requires approval, but this is an unattended run — "
        'no approver is available, so the step was blocked and recorded. '
        'Do not retry it. Choose a non-mutating approach, or finish the turn '
        'and tell the user which step needs manual approval.'
    )


def _resolveCommandApproval(
    session: WorkbenchSession, toolName: str, args: dict[str, object]
) -> str | None:
    """T5 approval axis (axis 2) for command tools.

    Returns None to proceed, or a receipt string to return to the model
    INSTEAD of executing. The real sandbox (axis 1) stays ground truth and
    still runs for anything approved — this layer only decides whether the
    user must be asked first, per the durable approval policy.
    """
    if toolName not in _COMMAND_TOOLS:
        return None
    command = as_str(args.get('command'), '').strip()
    if not command:
        return None
    policy = _loadApprovalPolicy(session)
    if not policy.enabled:
        return None
    from app.services.workbench.permissions import decide as _perm_decide
    from app.services.workbench.permissions import unattended_denial as _perm_unattended

    requires = as_bool(args.get('requires_approval'))
    decision = _perm_decide(
        command, session.workspacePath or '', policy, requires_approval=requires
    )
    if decision.action == 'allow':
        return None
    if decision.action == 'deny':
        return decision.feedback
    # action == 'ask'
    if _approval_never_ask(policy, session):
        _record_unattended_denial(session, toolName, decision.reason)
        return _perm_unattended(command, decision)
    # A prior one-shot/session/always grant covers exactly this command.
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
                f"Tool '{toolName}' is already waiting for the user's approval ({decision.reason}). "
                'Do not retry until the user approves or rejects it.'
            )
    mutation = createPendingMutation(session, toolName, dict(args))
    preview = _mutation_preview(toolName, args)
    if mutation is not None:
        mutation['preview'] = preview
        mutation['grantKey'] = key
        mutation['kind'] = 'approval_axis'
        mutation['approvalReason'] = decision.reason
        saveSessions()
        _emitSessionStatus(session.id)
    return (
        f"Command requires approval: {decision.reason}. "
        'A permission prompt was shown to the user (Accept / Reject, with once / this chat / always). '
        'Do not retry. If the user accepts, the command will run with the proposed arguments '
        'and you will receive the result automatically.'
    )


# Shell-family tools exempt from the read-only SANDBOX pre-check: run_command
# carries reads (type/cat/grep/dir) that must stay usable in read-only mode,
# and its own soft/OS preflight + sandbox backend deny the mutating forms.
# Keep in sync with the shell entries of tool_policy._PLAN_BLOCKED_EXACT.
_READ_ONLY_SHELL_PASSTHROUGH = frozenset({
    'run_command', 'run_commands', 'bash', 'bashtool', 'shell', 'exec', 'execute', 'terminal',
})


def _checkToolGuard(session: WorkbenchSession, toolName: str, args: dict[str, object]) -> str | None:
    """Check if a tool execution is blocked by guard mode or permissions.

    Returns None if allowed, or a string reason if blocked.
    In ask/edit mode, creates a pending mutation for the ApprovalBanner UI.
    Full Access never creates permission prompts — including for ``run_command``.
    """
    mode = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')

    # Codex read-only sandbox: block mutating tools via the CENTRAL classifier
    # (tool_policy.is_mutating — resolves bulk nested ops, edit_lines, mkdir,
    # the install/browser families; the old hand-maintained 11-name list had
    # drifted in both directions). Shell is deliberately excluded: run_command
    # still goes through the soft/OS preflight, which denies redirects and
    # mutating prefixes while leaving `type`/`cat`/`grep` reads usable.
    sandbox_mode = (getattr(session, 'sandboxMode', None) or 'workspace-write').strip().lower()
    if sandbox_mode in ('read-only', 'readonly', 'read'):
        name = (toolName or '').lower()
        if name not in _READ_ONLY_SHELL_PASSTHROUGH and is_mutating(name, args):
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
    # `bulk` is a META tool: bulk_tools.py routes operation=delete_sessions
    # to the same handler carrying the same sessionIds/sessionId args, and its
    # alias table maps delete_session -> delete_sessions. A name-only test
    # therefore let the aggregate path walk straight past this guard — while
    # the OTHER guard on this call site (is_mutating, via tool_policy) DOES
    # resolve nested bulk operations, so the two disagreed about the same
    # call. Resolve the operation first; the receipt keeps the real tool name
    # so it stays actionable.
    guardOp = toolName
    if toolName == 'bulk':
        _bulkOp = as_str(args.get('operation') or '', '').strip().lower()
        if _bulkOp == 'delete_session':
            _bulkOp = 'delete_sessions'  # mirrors bulk_tools' alias table
        if _bulkOp in ('delete_sessions', 'delete_folder'):
            guardOp = _bulkOp
    if guardOp in ('delete_session', 'delete_sessions', 'delete_folder'):
        currentId = session.id
        blockReason = None
        if guardOp == 'delete_session':
            target = as_str(args.get('sessionId') or args.get('session_id'), '')
            blockReason = currentId if (not target or target == currentId) else ''
        elif guardOp == 'delete_sessions':
            ids = [
                as_str(i, '')
                for i in as_list(args.get('sessionIds') or args.get('session_ids'), [])
                if isinstance(i, str)
            ]
            blockReason = currentId if currentId in ids else ''
        elif guardOp == 'delete_folder':
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
        # S-1 rider: an unattended run has no one to answer the banner — deny
        # with a receipt instead of queueing a pending mutation that soft-locks.
        if _approval_never_ask(_loadApprovalPolicy(session), session):
            _record_unattended_denial(session, toolName, 'shell mutation in edit mode')
            return _unattended_mutation_denial(toolName)
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
        # S-1 rider: same unattended denial as the edit-mode shell path —
        # routines ship with guardMode 'ask', so this is the live hang path.
        if _approval_never_ask(_loadApprovalPolicy(session), session):
            _record_unattended_denial(session, toolName, 'mutating tool in ask mode')
            return _unattended_mutation_denial(toolName)
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
                # Optional per-choice markdown previews (AskUserQuestion-style
                # side-by-side comparison) — single-select only, same order
                # as (and capped to) the choices list.
                raw_previews = q.get('previews') or []
                if isinstance(raw_previews, list) and not q.get('multiSelect'):
                    previews = [str(p) for p in raw_previews[:MAX_CLARIFY_CHOICES]]
                    if any(previews) and 'choices' in item:
                        item['previews'] = previews
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
            item: dict[str, object] = {'question': str(question), 'choices': choices}
            raw_previews = clarifyData.get('previews') or []
            if isinstance(raw_previews, list) and choices:
                previews = [str(p) for p in raw_previews[:MAX_CLARIFY_CHOICES]]
                if any(previews):
                    item['previews'] = previews
            incoming = [item]

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


def routeTodos(
    todosData: list[dict[str, object]],
    title: str = '',
    emit: 'Callable[[dict[str, object]], None] | None' = None,
) -> str:
    """Store a todo list for whoever is executing the current tool call.

    Inside a sub-agent worker (``currentSubagentTaskId`` set — asyncio tasks
    copy the context, so concurrent workers each see their own value), the
    list lands on that worker's orchestrator handle: unique per agent, never
    clobbering the parent session's list or a sibling worker's. On the main
    agent path it stores on the active session as before. Returns a short
    receipt the loop/fallback can hand back to the model.
    """
    from app.services.workbench.context import currentSubagentTaskId

    tid = currentSubagentTaskId.get()
    if tid:
        try:
            from app.services.runtime_services import get_orchestrator

            handle = get_orchestrator().getHandle(tid)
        except Exception:
            handle = None
        if handle is not None:
            handle.todos = todosData
            if emit:
                try:
                    emit(
                        {
                            'type': 'subagentTodos',
                            'jobId': tid,
                            'agentId': handle.agentId,
                            'todos': todosData,
                            'title': title or '',
                        }
                    )
                except Exception:
                    pass
            # 1.8: match the renderers' done-check (workbench.py:1463)
            # — accept the `done` flag and done/complete statuses, not just
            # 'completed', so workers using `done` don't get "0/N done".
            def _isDone(t: object) -> bool:
                if not isinstance(t, dict):
                    return False
                return bool(t.get('done')) or as_str(t.get('status') or '').lower() in (
                    'done',
                    'completed',
                    'complete',
                )

            done = sum(1 for t in todosData if _isDone(t))
            return f'Todo list updated for this worker ({done}/{len(todosData)} done).'
    session = get_session()
    if not session:
        return 'Error: no active workbench session.'
    submitTodos(session, todosData, title=title)
    return 'Todo list saved.'


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
        # Read by the approval card to decide whether a durable ("always")
        # choice may be offered; the same list clamps the request server-side.
        'categories': _mutation_categories(toolName, args, session.workspacePath or ''),
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
            stored_scope, scope_note = add_tool_grant(
                session,
                tool_name,
                args,
                scope=scope,
                # Prefer the classification captured when the card was raised so
                # the offer the user saw and the clamp applied are the same one.
                categories=(
                    [str(c) for c in as_list(pm.get('categories'))]
                    if pm.get('categories') is not None
                    else None
                ),
            )
            saveSessions()
            _emitSessionStatus(session.id)
            result = {
                'status': 'approved',
                'sessionId': session.id,
                'toolName': tool_name,
                'args': args,
                'preview': preview,
                'scope': stored_scope,
                'grantKey': _mutation_grant_key(tool_name, args),
                'remainingPending': len(session.pendingMutations),
            }
            if scope_note:
                result['scopeNote'] = scope_note
            return result
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
    # A human just approved THIS call. Desktop actions additionally consult the
    # per-app computer-use policy at the primitive, and the window in front may
    # have changed since the prompt was raised — re-evaluating would either
    # re-prompt forever or act on the wrong target. The flag is consumed by the
    # gate (one approval, one action).
    from app.services.computer_use_policy import clearApproved, markApproved

    approvalToken = markApproved()
    try:
        result = await _executeTool(tool_name, args, session)
    finally:
        clearApproved(approvalToken)
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
            'update_state',
            'write_scratchpad',
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
            'spawn_subagents',
            'spawn_daemon',
            'kill_daemon',
            'interrupt_subagent',
            'send_subagent_message',
            'write_blackboard',
            'clear_blackboard',
            'remember',
        }
    )
    allTools = regListTools()
    grouped: dict[str, list[dict[str, object]]] = {}
    for tool in allTools:
        # RegListTools() returns {type, function:{name}} entries
        # with no top-level `name`, so the old `tool.get('name','')` was always
        # '' and every tool was skipped (tools_by_group={}, mutating_tools=0).
        name = _toolDefName(tool) if isinstance(tool, dict) else str(tool)
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
        elif name in ('brain_query', 'remember'):
            group = 'memory'
        elif name in ('load_skill', 'load_skills', 'list_skills'):
            group = 'skill'
        elif name in ('web_fetch', 'web_search'):
            group = 'web'
        elif name in ('spawn_subagents', 'create_agent', 'list_agents', 'list_workstreams', 'send_subagent_message', 'interrupt_subagent'):
            group = 'agent'
        elif name in ('spawn_daemon', 'list_daemons', 'kill_daemon'):
            group = 'daemon'
        elif name in ('tool_search', 'tool_describe', 'tool_call'):
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
    the whole dispatch) so execution state / scratchpad land on the session
    whose turn is actually executing — with ≥2 open chats, the
    max-``updatedAt`` heuristic resolved to the WRONG session (false stall
    hard-stops, the wrong chat's agent mode rewired). Falls back to the most
    recently touched session only for callers outside a tool dispatch.
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
            prevState = getattr(session, '_execution_state', None)
            session._execution_state = executionState
            if hasattr(session, 'save') and callable(session.save):
                session.save()
            # Stream phase/step changes to the live UI (the inline working
            # strip shows "implement · step 3"). Only on real transitions —
            # same-phase step bumps would spam the stream otherwise.
            prevPhase = as_str(as_dict(prevState).get('phase'), '') if prevState else ''
            prevStep = as_int(as_dict(prevState).get('step'), 0) if prevState else 0
            newPhase = as_str(executionState.get('phase'), '')
            newStep = as_int(executionState.get('step'), 0)
            if (newPhase and newPhase != prevPhase) or (newStep and newStep != prevStep):
                try:
                    from app.services.event_log import event_log

                    event_log.append(
                        session.id,
                        'executionState',
                        {
                            'type': 'executionState',
                            'phase': newPhase,
                            'step': newStep,
                            'completed': as_list(executionState.get('completed'), [])[:8],
                            'blockers': as_list(executionState.get('blockers'), [])[:8],
                        },
                    )
                except Exception:
                    logger.debug('executionState emit failed', exc_info=True)
            return True
        finally:
            session._state_lock.release()
    except asyncio.TimeoutError:
        return False
    except RuntimeError:
        return False
