"""
Sub-agent execution — port of ``backend/services/workbench/workbench.js``
``executeSubAgent``.

Runs a created agent autonomously as a sub-agent: resolves its inherited
model alias (applying the previously-unread ``subAgentFallback`` config),
enforces the depth cap, inherits permissions, then runs a focused tool loop
reusing the workbench model callers + tool registry. Lifecycle events are
emitted to the parent session's SSE stream as ``subagent_*`` events.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Callable, cast

from app.json_narrowing import as_bool, as_dict, as_int, as_list, as_str
from app.services.tools.agent_registry import (
    _MAXAgentDepth,
    createJob,
    deriveChildPermissions,
    evaluateAgentTool,
    getAgent,
    renderAgentContext,
    updateJob,
)
from app.services.workbench.context import currentSessionId

# A provider call that never returns must not hang the worker (and with it
# a semaphore slot) forever. Timeouts surface as retryable 503s, then the
# worker fails per the retry policy.
SUBAGENT_MODEL_TIMEOUT_S = 240

# Sub-agent recursion guard: BOTH spawn tool spellings must be excluded or a
# sub-agent can recurse through the plural tool — the old singular-only
# filter allowed unbounded recursion + semaphore-slot deadlock.
SUBAGENT_BLOCKED_TOOLS = frozenset({'spawn_subagent', 'spawn_subagents'})


def _toolName(t: dict[str, object]) -> str:
    return as_str(t.get('name')) or as_str(as_dict(t.get('function')).get('name', ''))


def _agentOrGeneral(agentId: str, parentAlias: str) -> dict[str, object]:
    """Return the persisted agent, or a synthetic fallback for known roles."""
    agent = getAgent(agentId)
    if agent:
        return agent
    aid = (agentId or 'general').strip() or 'general'
    known = {
        'general': ('General', 'General-purpose fallback sub-agent.'),
        'explore': ('Explore', 'Read-only codebase exploration sub-agent.'),
        'plan': ('Plan', 'Planning-focused sub-agent.'),
        'shell': ('Shell', 'Command-oriented sub-agent.'),
    }
    name, desc = known.get(aid.lower(), (aid.title() or 'General', f'Synthetic sub-agent ({aid}).'))
    return {
        'id': aid.lower() if aid.lower() in known else 'general',
        'name': name,
        'role': name,
        'description': desc,
        'permissions': ['all'],
        'modelAlias': parentAlias,
        'depth': 0,
        '_synthetic': True,
    }


def _toolAllowed(agent: dict[str, object], name: str) -> bool:
    if 'all' in as_list(agent.get('permissions'), []):
        return True
    aid = as_str(agent.get('id'))
    if aid and (not as_bool(agent.get('_synthetic', False))) and getAgent(aid):
        return bool(as_bool(evaluateAgentTool(aid, name).get('allowed', False)))
    return True


async def executeSubAgent(
    session: object,
    agentId: str,
    goal: str,
    context: str = '',
    emit: Callable[[dict[str, object]], None] | None = None,
    job_id: str | None = None,
    restricted_names: set[str] | None = None,
    yield_schema: dict[str, object] | None = None,
    effort: str = 'medium',
    model_override: str = '',
    depth: int = 0,
) -> dict[str, object]:
    """Execute a sub-agent task and return ``{jobId, agentId, status, result}``.

    When ``job_id`` is provided (API-created jobs), reuse that row instead of
    creating a second pending job. ``restricted_names`` filters the tool
    surface (both wire formats) for worker-launched sub-agents — callers must
    never mutate the module-level ``toolDefinitions``, which races across
    concurrent workers. ``yield_schema`` (optional JSON Schema) makes the
    agent return a single JSON object; the result is validated and returned
    as parsed JSON when it matches. ``effort`` maps to the reasoning/thinking
    budget (default 'medium'); ``model_override`` pins the model instead of
    the agent alias / smol role routing. ``depth`` is the runtime recursion
    depth (spawner threads it; root spawns are 0).
    """
    from app.providers.model_resolver import resolve_or_fallback
    from app.providers.route_resolver import resolve_for_model
    from app.services.fallback_service import getFallback
    from app.services.tool_registry import dispatch as dispatchTool
    from app.services.workbench.validator import validationErrorText
    from app.services.workbench.workbench import (
        WorkbenchSession,
        _callAnthropicWorkbench,
        _callOpenaiWorkbench,
        _extractText,
        _isAnthropicProvider,
        _isOpenaiProvider,
        _isRetryableModelError,
        _managedToolLoopCap,
        _modelRetryDelayMs,
        _modelRetryPolicy,
        _resolveModel,
        _resolveWorkbenchProvider,
        openaiToolDefinitions,
        toolDefinitions,
    )

    parentAlias = getattr(session, 'model', '') or ''
    agent = _agentOrGeneral(agentId, parentAlias)
    resolvedAgentId = as_str(agent.get('id')) or agentId
    definedDepth = as_int(agent.get('depth', 0), 0)
    # Runtime recursion depth (threaded from the spawner) is authoritative;
    # the agent-definition depth remains a floor for backward compatibility.
    runtimeDepth = max(depth, definedDepth)
    if runtimeDepth >= _MAXAgentDepth:
        blocked_msg = f'Sub-agent depth cap reached ({runtimeDepth} >= {_MAXAgentDepth}).'
        if emit:
            emit({'type': 'subagentDone', 'agentId': resolvedAgentId, 'status': 'blocked', 'error': blocked_msg})
        if job_id:
            updateJob(job_id, {'status': 'failed', 'error': blocked_msg})
        return {'agentId': resolvedAgentId, 'status': 'blocked', 'error': blocked_msg}

    # Carry the runtime depth on the session so any nested spawn (even one
    # that slips past the tool filter) inherits depth+1 instead of resetting
    # to 0 and re-entering the recursion.
    try:
        setattr(session, 'subagent_depth', runtimeDepth)
    except Exception:
        pass

    # Publish the launch before any workspace setup.  Git can take noticeable
    # time on large repositories; without this event the UI has no indication
    # that the accepted tool call is actually progressing.
    if job_id:
        existing = updateJob(job_id, {'status': 'running', 'agentId': resolvedAgentId, 'goal': goal})
        if existing is None:
            job = createJob(resolvedAgentId, goal, context)
            jobId = as_str(job['id'])
            updateJob(jobId, {'status': 'running'})
        else:
            jobId = job_id
            job = existing
    else:
        job = createJob(resolvedAgentId, goal, context)
        jobId = as_str(job['id'])
        updateJob(jobId, {'status': 'running'})

    # NOTE: automatic git-worktree isolation is intentionally NOT performed
    # here. Tool dispatch resolves paths against the parent session's
    # workspace, so a per-subagent worktree would be created and then never
    # used (misleading). Isolated workspaces remain available on demand via
    # POST /api/workbench/sessions/{id}/worktree; parallel agents share the
    # main tree by default.
    if emit:
        try:
            from app.services.workbench.context import currentToolUseId

            parentToolUseId = currentToolUseId.get()
        except Exception:
            parentToolUseId = ''
        emit(
            {
                'type': 'subagentStart',
                'agentId': resolvedAgentId,
                'jobId': jobId,
                'name': as_str(agent.get('name'), 'General'),
                'role': as_str(agent.get('role'), ''),
                'goal': goal,
                'task': goal,
                'parentToolUseId': parentToolUseId or None,
            }
        )

    aliasHint = model_override or as_str(agent.get('modelAlias')) or parentAlias or ''
    resolution = resolve_or_fallback(aliasHint, provider_hint=getattr(session, 'provider', '') or '')
    model = as_str((resolution or {}).get('model')) or aliasHint or ''
    providerName = as_str((resolution or {}).get('provider')) or ''
    isFallback = as_bool((resolution or {}).get('is_fallback', False))
    provider = _resolveWorkbenchProvider(providerName, model)
    if not provider:
        provider = resolve_for_model(model, providerName) if model else None
    fb = getFallback()
    if (
        as_bool(fb.get('enabled', False))
        and as_str(fb.get('mode')) != 'off'
        and (as_str(fb.get('provider')) or as_str(fb.get('model')))
    ):
        fbModel = as_str(fb.get('model')) or model
        fbProvider = resolve_for_model(fbModel, as_str(fb.get('provider')) or '')
        if fbProvider:
            provider = fbProvider
            model = fbModel
            isFallback = True
            if emit:
                emit(
                    {
                        'type': 'warning',
                        'kind': 'model_fallback',
                        'agentId': resolvedAgentId,
                        'message': f'Sub-agent using fallback {as_str(fb.get("provider"))}/{fbModel}',
                    }
                )
    # Role routing (surpass #2): subagents default to the cheap "smol" fleet
    # model when configured and the agent has no explicit model alias.
    if not aliasHint:
        try:
            from app.services.model_fleet_service import getModelForRole

            smol = getModelForRole('chat_smol').strip()
            if smol:
                smolProvider = resolve_for_model(smol, '')
                if smolProvider:
                    provider = smolProvider
                    model = smol
        except Exception:
            pass
    if not provider:
        err = 'No provider available for sub-agent.'
        if emit:
            emit({'type': 'subagentDone', 'agentId': resolvedAgentId, 'jobId': jobId, 'status': 'error', 'error': err})
        updateJob(jobId, {'status': 'failed', 'error': err})
        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'error', 'error': err}
    resolvedModel = _resolveModel(provider, model)
    agentCtx = renderAgentContext(resolvedAgentId) if not as_bool(agent.get('_synthetic', False)) else ''
    if not agentCtx:
        agentCtx = f'Agent: {as_str(agent.get("name"), "General")}\nRole: {as_str(agent.get("role"), "General")}'
    parentId = getattr(session, 'agent_id', '') or None
    if parentId and (not as_bool(agent.get('_synthetic', False))):
        try:
            deriveChildPermissions(parentId, resolvedAgentId)
        except Exception:
            pass
    fullTools = toolDefinitions(cast(WorkbenchSession, session))
    fullOpenaiTools = openaiToolDefinitions(cast(WorkbenchSession, session))
    if restricted_names:
        fullTools = [t for t in fullTools if _toolName(t) not in restricted_names]
        fullOpenaiTools = [t for t in fullOpenaiTools if _toolName(t) not in restricted_names]
    allowedNames = {
        _toolName(t)
        for t in fullTools
        if _toolAllowed(agent, _toolName(t)) and _toolName(t) not in SUBAGENT_BLOCKED_TOOLS
    }
    tools = [t for t in fullTools if _toolName(t) in allowedNames]
    openaiTools = [t for t in fullOpenaiTools if _toolName(t) in allowedNames]
    try:
        from app.services.memory.capabilities_prompt import (
            build_capabilities_block,
            skills_tools_allowed,
        )

        caps = build_capabilities_block(
            sorted(allowedNames),
            include_skills=skills_tools_allowed(allowedNames),
        )
    except Exception:
        caps = ''
    systemText = (
        f'{agentCtx}\n\n'
        'You are a focused sub-agent. Complete the assigned goal using the available tools, '
        'then return a concise final answer. Do not spawn further sub-agents.\n\n'
        f'{caps}'
    )
    isAnthropic = _isAnthropicProvider(provider)
    isOpenai = _isOpenaiProvider(provider)

    def _subEmit(ev: dict[str, object]) -> None:
        if not emit:
            return
        if as_str(ev.get('type')) == 'finalOutput':
            emit(
                {
                    'type': 'subagentText',
                    'agentId': resolvedAgentId,
                    'jobId': jobId,
                    'content': as_str(ev.get('content'), ''),
                }
            )

    goalText = goal
    if yield_schema:
        import json as _json

        goalText += (
            '\n\nReturn your final answer as a SINGLE JSON object (no prose, no markdown '
            'fences) matching this schema:\n'
            f'{_json.dumps(yield_schema, indent=2)}\n'
            'The parent agent reads your result programmatically, so every field the '
            'schema requires must be present and correctly typed.'
        )
    messages: list[dict[str, object]] = [
        {'role': 'user', 'content': f'Goal: {goalText}\n\nContext: {context}' if context else f'Goal: {goalText}'}
    ]
    finalText = ''
    token = currentSessionId.set(getattr(session, 'id', 'default'))
    try:
        toolRound = 0
        # Sub-agents get the same retry discipline as the parent loop: a
        # transient 429/5xx must not kill the agent outright.
        retryPolicy = _modelRetryPolicy()
        managedToolLoopCap = _managedToolLoopCap()
        # Same malformed-JSON discipline as the parent loop: consecutive
        # invalid tool arguments must never execute as a phantom arg.
        subInvalidCount = 0
        subInvalidNudged = False
        # Stall detection (parent-loop parity): a sub-agent that never
        # advances phase/step gets one reflection nudge, then hard-stops.
        from app.services.workbench.workbench import (
            MAX_STALLED_ROUNDS,
            MIN_ROUNDS_BEFORE_STALL_CHECK,
            _is_failing_receipt,
            _is_update_state_transition,
            _resolveModelContextWindow,
        )

        stalledRounds = 0
        stallMessageSent = False
        lastExecSig: tuple[object, object] | None = None
        while True:
            toolRound += 1
            # 0 = unlimited (same default as main workbench loop)
            if managedToolLoopCap > 0 and toolRound > managedToolLoopCap:
                break
            # Context compaction: long tool runs must not overflow the
            # window. Threshold scales with the RESOLVED sub-agent model
            # (subagents default to cheap 32k/64k models — the old hardcoded
            # 110k threshold overflowed those windows before compaction ran).
            try:
                from app.providers.clients.base import estimateTokens as _estimateTokens
                from app.services.memory.context_compressor import compressMessages

                _contextWindow = _resolveModelContextWindow(resolvedModel, provider)
                _threshold = max(4096, int(_contextWindow * 0.55))
                if _estimateTokens(messages) > _threshold:
                    messages = await compressMessages(
                        messages,
                        threshold=_threshold,
                        # Landmark pins (P4): update_state transitions and
                        # failing receipts survive the middle summary.
                        pin_predicates=[_is_update_state_transition, _is_failing_receipt],
                    )
            except Exception:
                pass
            response: dict[str, object] | None = None
            for retryAttempt in range(retryPolicy['maxRetries'] + 1):
                try:
                    if isAnthropic:
                        response = await asyncio.wait_for(
                            _callAnthropicWorkbench(
                                messages, systemText, resolvedModel, tools, effort, provider=provider, emit=_subEmit
                            ),
                            timeout=SUBAGENT_MODEL_TIMEOUT_S,
                        )
                    elif isOpenai:
                        response = await asyncio.wait_for(
                            _callOpenaiWorkbench(
                                messages, systemText, resolvedModel, openaiTools, effort, provider=provider, emit=_subEmit
                            ),
                            timeout=SUBAGENT_MODEL_TIMEOUT_S,
                        )
                    else:
                        err = 'Unsupported provider type for sub-agent.'
                        if emit:
                            emit(
                                {
                                    'type': 'subagentDone',
                                    'agentId': resolvedAgentId,
                                    'jobId': jobId,
                                    'status': 'error',
                                    'error': err,
                                }
                            )
                        updateJob(jobId, {'status': 'failed', 'error': err})
                        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'error', 'error': err}
                except asyncio.TimeoutError:
                    # A provider call that never returns must not hang the
                    # worker (and with it a semaphore slot) forever — surface
                    # it as a retryable transient error, then give up per the
                    # retry policy below.
                    response = {
                        'error': f'Sub-agent model call timed out after {SUBAGENT_MODEL_TIMEOUT_S}s',
                        'errorStatus': 503,
                    }
                if response is None or not _isRetryableModelError(response):
                    break
                if retryAttempt >= retryPolicy['maxRetries']:
                    break
                delayMs = _modelRetryDelayMs(retryAttempt + 1, response, retryPolicy)
                await asyncio.sleep(delayMs / 1000)
            response = response or {'error': 'Sub-agent model call failed'}
            if as_str(response.get('error')):
                err = as_str(response.get('error')) or 'Sub-agent model error'
                if emit:
                    emit(
                        {
                            'type': 'subagentText',
                            'agentId': resolvedAgentId,
                            'jobId': jobId,
                            'content': f'[error] {err}',
                        }
                    )
                    emit(
                        {
                            'type': 'subagentDone',
                            'agentId': resolvedAgentId,
                            'jobId': jobId,
                            'status': 'error',
                            'error': err,
                        }
                    )
                updateJob(jobId, {'status': 'failed', 'error': err})
                return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'error', 'error': err}
            if response.get('stream_rule'):
                # Stream rule fired mid-generation (the model narrated a tool
                # call instead of emitting one) — inject the same reminder
                # the parent loop uses and retry this round. Previously the
                # sub-agent loop ignored stream_rule and `break` on the empty
                # tool_uses, silently ending the sub-agent with partial text.
                messages.append(
                    {
                        'role': 'user',
                        'content': (
                            '[Proxy Self-Heal] Stop narrating tool calls in prose. When you need a '
                            'tool, emit it as an actual tool call; do not describe it in text. '
                            'Continue with the task.'
                        ),
                    }
                )
                if emit:
                    emit(
                        {
                            'type': 'subagentWarning',
                            'agentId': resolvedAgentId,
                            'jobId': jobId,
                            'message': (
                                'Sub-agent narrated a tool call instead of emitting it — '
                                'nudging it to call tools directly.'
                            ),
                        }
                    )
                continue
            assistantMsg: dict[str, object]
            if isAnthropic:
                contentBlocks = [as_dict(b) for b in as_list(response.get('content'), [])]
                assistantMsg = {'role': 'assistant', 'content': contentBlocks}
                textContent = _extractText(contentBlocks)
                toolUses = [b for b in contentBlocks if as_str(b.get('type')) == 'tool_use']
            else:
                choices = as_list(response.get('choices'), [])
                choice = as_dict(choices[0]) if choices else {}
                msg = as_dict(choice.get('message'), {})
                assistantMsg = {
                    'role': 'assistant',
                    'content': as_str(msg.get('content'), ''),
                    'tool_calls': as_list(msg.get('tool_calls'), []),
                }
                textContent = as_str(response.get('text'), '')
                from app.adapters.reasoning_policy import attach_openai_reasoning

                attach_openai_reasoning(
                    assistantMsg,
                    as_str(response.get('thinking'), '')
                    or as_str(msg.get('reasoning_content') or msg.get('reasoning'), ''),
                )
                toolUses = [as_dict(tu) for tu in as_list(response.get('tool_uses'), [])]
            if textContent:
                finalText += textContent
            if not toolUses:
                break
            # Stall detection (parent-loop parity): a sub-agent that never
            # advances its execution phase/step is spinning — nudge once,
            # hard-stop shortly after if it ignores the nudge.
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
                    else:
                        stalledRounds += 1
                        if stalledRounds >= MAX_STALLED_ROUNDS and not stallMessageSent:
                            stallMessageSent = True
                            messages.append(
                                {
                                    'role': 'user',
                                    'content': (
                                        f'[Proxy Self-Heal] {toolRound} tool rounds have elapsed without '
                                        'advancing your execution phase/step. Reflect on what is blocking '
                                        'you, record where you are with update_state(phase=..., step=...), '
                                        'then either take a different approach or finish with a final answer.'
                                    ),
                                }
                            )
                            if emit:
                                emit(
                                    {
                                        'type': 'subagentWarning',
                                        'agentId': resolvedAgentId,
                                        'jobId': jobId,
                                        'message': (
                                            'Sub-agent made no progress across many tool rounds — '
                                            'nudged it to reflect.'
                                        ),
                                    }
                                )
                        elif stallMessageSent and stalledRounds >= MAX_STALLED_ROUNDS + 2:
                            err = 'Sub-agent stopped: it did not recover after the stall warning.'
                            if emit:
                                emit(
                                    {
                                        'type': 'subagentDone',
                                        'agentId': resolvedAgentId,
                                        'jobId': jobId,
                                        'status': 'error',
                                        'error': err,
                                    }
                                )
                            updateJob(jobId, {'status': 'failed', 'error': err})
                            return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'error', 'error': err}
            messages.append(assistantMsg)
            toolResults: list[dict[str, object]] = []
            for tu in toolUses:
                tName = as_str(tu.get('name'), '')
                tInput = as_dict(tu.get('input'), {})
                tId = as_str(tu.get('id'), f'toolu_{uuid.uuid4().hex[:16]}')
                if not _toolAllowed(agent, tName) or tName in SUBAGENT_BLOCKED_TOOLS:
                    result = f"[Blocked] Sub-agent not permitted to use '{tName}'."
                    status = 'blocked'
                else:
                    if emit:
                        emit(
                            {
                                'type': 'subagentToolCall',
                                'agentId': resolvedAgentId,
                                'jobId': jobId,
                                'id': tId,
                                'name': tName,
                                'input': tInput,
                            }
                        )
                    # Malformed-JSON parity with the parent loop: a call whose
                    # arguments failed to parse must not execute with a
                    # phantom `_invalid_json`/`_raw` arg — surface a
                    # validation-error result so the sub-agent self-heals.
                    invalidRaw = as_str(tInput.get('_invalid_json') or tInput.get('_raw'), '')
                    if invalidRaw:
                        subInvalidCount += 1
                        result = validationErrorText(tName, invalidRaw[:500], malformed=True)
                        status = 'error'
                        if subInvalidCount >= 3 and not subInvalidNudged:
                            subInvalidNudged = True
                            if emit:
                                emit(
                                    {
                                        'type': 'subagentWarning',
                                        'agentId': resolvedAgentId,
                                        'jobId': jobId,
                                        'message': (
                                            f'Sub-agent tool arguments failed to parse '
                                            f'{subInvalidCount} times in a row — the model is '
                                            'improvising JSON instead of using the tool schema.'
                                        ),
                                    }
                                )
                    else:
                        try:
                            result = await dispatchTool(tName, tInput)
                        except Exception as exc:
                            result = f'Error executing {tName}: {exc}'
                        status = 'done'
                resultStr = str(result)
                if emit:
                    emit(
                        {
                            'type': 'subagentToolResult',
                            'agentId': resolvedAgentId,
                            'jobId': jobId,
                            'id': tId,
                            'name': tName,
                            'content': resultStr[:2000],
                            'status': status,
                        }
                    )
                toolResults.append({'tool_use_id': tId, 'role': 'tool', 'content': resultStr})
            messages.extend(toolResults)
        # Schema-validated yields (Oh My Pi lesson): when a yield_schema was
        # requested, parse the final text as JSON and validate it before
        # returning — the parent reads a structured object, not prose. A
        # failed yield must report status='failed' (not 'completed') so the
        # orchestrator tallies it as a loss and the parent can retry.
        resultText = finalText
        yieldFailed = False
        if yield_schema and finalText.strip():
            try:
                import json as _json

                from app.services.workbench.json_salvage import salvage_json_object

                parsed = salvage_json_object(finalText)
                if not isinstance(parsed, dict):
                    try:
                        parsed = _json.loads(finalText.strip().strip('`'))
                    except (_json.JSONDecodeError, TypeError, ValueError):
                        parsed = None
                if isinstance(parsed, dict):
                    from app.services.workbench.validator import validateToolArguments

                    check = validateToolArguments(
                        {
                            'function': {
                                'name': 'yield',
                                'arguments': _json.dumps(parsed),
                            }
                        },
                        [{'function': {'name': 'yield', 'parameters': yield_schema}}],
                    )
                    if as_bool(check.get('valid'), False):
                        resultText = _json.dumps(parsed, ensure_ascii=False)
                    else:
                        yieldFailed = True
                        resultText = (
                            f'[yield validation failed: {as_str(check.get("error"), "schema mismatch")}]\n'
                            f'Raw answer:\n{finalText[:4000]}'
                        )
                else:
                    yieldFailed = True
                    resultText = f'[yield validation failed: expected a JSON object]\nRaw answer:\n{finalText[:4000]}'
            except Exception:
                yieldFailed = True
                resultText = f'[yield validation failed: answer was not valid JSON]\nRaw answer:\n{finalText[:4000]}'
        elif not resultText.strip():
            # A tool-only sub-agent that finishes cleanly returns no text.
            # The orchestrator treats a completed-but-empty payload as a
            # failure (B27), so synthesize an honest summary instead of
            # letting a clean run tally as failed.
            resultText = f'(Sub-agent completed after {toolRound} tool round(s) with no textual answer.)'
        if yieldFailed:
            yieldErr = 'yield schema validation failed'
            updateJob(jobId, {'status': 'failed', 'error': yieldErr, 'result': resultText[:2000]})
            if emit:
                emit(
                    {
                        'type': 'subagentDone',
                        'agentId': resolvedAgentId,
                        'jobId': jobId,
                        'status': 'failed',
                        'error': yieldErr,
                        'result': resultText[:4000],
                        'isFallback': isFallback,
                    }
                )
            return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'failed', 'error': yieldErr, 'result': resultText}
        updateJob(jobId, {'status': 'completed', 'result': resultText[:2000]})
        if emit:
            emit(
                {
                    'type': 'subagentDone',
                    'agentId': resolvedAgentId,
                    'jobId': jobId,
                    'status': 'completed',
                    'result': resultText[:4000],
                    'isFallback': isFallback,
                }
            )
        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'completed', 'result': resultText}
    except Exception as exc:
        updateJob(jobId, {'status': 'failed', 'error': str(exc)})
        if emit:
            emit(
                {
                    'type': 'subagentDone',
                    'agentId': resolvedAgentId,
                    'jobId': jobId,
                    'status': 'error',
                    'error': str(exc),
                }
            )
        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'error', 'error': str(exc)}
    finally:
        currentSessionId.reset(token)
