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


def _toolName(t: dict[str, object]) -> str:
    return as_str(t.get('name')) or as_str(as_dict(t.get('function')).get('name', ''))


def _cleanup_agent_worktree(session: object, workspace: str, worktree_path: str) -> None:
    """Best-effort remove of a sub-agent worktree and session metadata bookkeeping."""
    if not worktree_path or not workspace:
        return
    try:
        from app.services.workbench.worktree_service import remove_agent_worktree

        remove_agent_worktree(workspace, worktree_path)
    except Exception:
        pass
    try:
        import os

        if os.environ.get('AUGUST_SUBAGENT_WORKTREE') == worktree_path:
            os.environ.pop('AUGUST_SUBAGENT_WORKTREE', None)
    except Exception:
        pass
    try:
        meta2 = as_dict(getattr(session, 'metadata', None)) if getattr(session, 'metadata', None) else {}
        active = [
            a
            for a in as_list(meta2.get('activeAgentWorktrees'), [])
            if not (isinstance(a, dict) and str(a.get('path')) == worktree_path)
        ]
        meta2['activeAgentWorktrees'] = active
        session.metadata = meta2  # type: ignore[attr-defined]
    except Exception:
        pass


def _agentOrGeneral(agentId: str, parentAlias: str) -> dict[str, object]:
    """Return the persisted agent, or a synthetic 'general' fallback."""
    agent = getAgent(agentId)
    if agent:
        return agent
    return {
        'id': 'general',
        'name': 'General',
        'role': 'General',
        'description': 'General-purpose fallback sub-agent.',
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
    session: object, agentId: str, goal: str, context: str = '', emit: Callable[[dict[str, object]], None] | None = None
) -> dict[str, object]:
    """Execute a sub-agent task and return ``{jobId, agentId, status, result}``."""
    from app.providers.model_resolver import resolve_or_fallback
    from app.providers.route_resolver import resolve_for_model
    from app.services.fallback_service import getFallback
    from app.services.tool_registry import dispatch as dispatchTool
    from app.services.workbench.workbench import (
        MAX_MANAGED_TOOL_ROUNDS,
        _callAnthropicWorkbench,
        _callOpenaiWorkbench,
        _extractText,
        _isAnthropicProvider,
        _isOpenaiProvider,
        _resolveModel,
        _resolveWorkbenchProvider,
        WorkbenchSession,
        openaiToolDefinitions,
        toolDefinitions,
    )

    parentAlias = getattr(session, 'model', '') or ''
    agent = _agentOrGeneral(agentId, parentAlias)
    resolvedAgentId = as_str(agent.get('id')) or agentId
    depth = as_int(agent.get('depth', 0))
    if depth >= _MAXAgentDepth:
        blocked_msg = f'Sub-agent depth cap reached ({depth} >= {_MAXAgentDepth}).'
        if emit:
            emit({'type': 'subagentDone', 'agentId': resolvedAgentId, 'status': 'blocked', 'error': blocked_msg})
        return {'agentId': resolvedAgentId, 'status': 'blocked', 'error': blocked_msg}

    # Git worktree isolation for parallel agents.
    # Default ON when isolateSubagents is unset (parallel agents keep files separate).
    # Explicit False (via isolateSubagentsExplicit + isolateSubagents=false) opts out.
    worktree_path = ''
    meta = as_dict(getattr(session, 'metadata', None)) if getattr(session, 'metadata', None) is not None else {}
    if 'isolateSubagents' in meta:
        isolate = bool(meta.get('isolateSubagents'))
    else:
        # Default: isolate so parallel agents do not collide on the main tree
        isolate = True
    workspace = as_str(getattr(session, 'workspacePath', ''))
    if isolate and workspace:
        try:
            from app.services.workbench.worktree_service import create_agent_worktree

            wt = create_agent_worktree(
                workspace,
                session_id=as_str(getattr(session, 'id', '')),
                agent_label=resolvedAgentId or 'agent',
            )
            if wt.get('ok') and wt.get('path'):
                worktree_path = str(wt['path'])
                # Prefer isolated cwd for tools that honor AUGUST_WORKTREE / session path
                try:
                    import os

                    os.environ['AUGUST_SUBAGENT_WORKTREE'] = worktree_path
                except Exception:
                    pass
                # Persist active worktree path for UI badge / cleanup
                try:
                    meta = dict(meta)
                    active = list(as_list(meta.get('activeAgentWorktrees'), []))
                    active.append(
                        {
                            'agentId': resolvedAgentId,
                            'path': worktree_path,
                        }
                    )
                    meta['activeAgentWorktrees'] = active
                    meta['isolateSubagents'] = True
                    setattr(session, 'metadata', meta)
                except Exception:
                    pass
        except Exception:
            worktree_path = ''

    job = createJob(resolvedAgentId, goal, context)
    jobId = as_str(job['id'])
    updateJob(jobId, {'status': 'running'})
    if emit:
        emit(
            {
                'type': 'subagentStart',
                'agentId': resolvedAgentId,
                'jobId': jobId,
                'name': as_str(agent.get('name'), 'General'),
                'role': as_str(agent.get('role'), ''),
                'goal': goal,
                'worktreePath': worktree_path or None,
                'isolated': bool(worktree_path),
            }
        )
    aliasHint = as_str(agent.get('modelAlias')) or parentAlias or ''
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
    if not provider:
        err = 'No provider available for sub-agent.'
        if emit:
            emit({'type': 'subagentDone', 'agentId': resolvedAgentId, 'jobId': jobId, 'status': 'error', 'error': err})
        updateJob(jobId, {'status': 'failed', 'error': err})
        _cleanup_agent_worktree(session, workspace, worktree_path)
        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'error', 'error': err}
    resolvedModel = _resolveModel(provider, model)
    agentCtx = renderAgentContext(resolvedAgentId) if not as_bool(agent.get('_synthetic', False)) else ''
    if not agentCtx:
        agentCtx = f'Agent: {as_str(agent.get("name"), "General")}\nRole: {as_str(agent.get("role"), "General")}'
    systemText = f'{agentCtx}\n\nYou are a focused sub-agent. Complete the assigned goal using the available tools, then return a concise final answer. Do not spawn further sub-agents.'
    parentId = getattr(session, 'agent_id', '') or None
    if parentId and (not as_bool(agent.get('_synthetic', False))):
        try:
            deriveChildPermissions(parentId, resolvedAgentId)
        except Exception:
            pass
    fullTools = toolDefinitions(cast(WorkbenchSession, session))
    fullOpenaiTools = openaiToolDefinitions(cast(WorkbenchSession, session))
    allowedNames = {
        _toolName(t) for t in fullTools if _toolAllowed(agent, _toolName(t)) and _toolName(t) != 'spawn_subagent'
    }
    tools = [t for t in fullTools if _toolName(t) in allowedNames]
    openaiTools = [t for t in fullOpenaiTools if _toolName(t) in allowedNames]
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

    messages: list[dict[str, object]] = [
        {'role': 'user', 'content': f'Goal: {goal}\n\nContext: {context}' if context else f'Goal: {goal}'}
    ]
    finalText = ''
    token = currentSessionId.set(getattr(session, 'id', 'default'))
    try:
        toolRound = 0
        while True:
            toolRound += 1
            # 0 = unlimited (same default as main workbench loop)
            if MAX_MANAGED_TOOL_ROUNDS > 0 and toolRound > MAX_MANAGED_TOOL_ROUNDS:
                break
            if isAnthropic:
                response = await _callAnthropicWorkbench(
                    messages, systemText, resolvedModel, tools, 'medium', provider=provider, emit=_subEmit
                )
            elif isOpenai:
                response = await _callOpenaiWorkbench(
                    messages, systemText, resolvedModel, openaiTools, 'medium', provider=provider, emit=_subEmit
                )
            else:
                break
            if as_str(response.get('error')):
                if emit:
                    emit(
                        {
                            'type': 'subagentText',
                            'agentId': resolvedAgentId,
                            'jobId': jobId,
                            'content': f'[error] {response["error"]}',
                        }
                    )
                break
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
                toolUses = [as_dict(tu) for tu in as_list(response.get('tool_uses'), [])]
            if textContent:
                finalText += textContent
            if not toolUses:
                break
            messages.append(assistantMsg)
            toolResults: list[dict[str, object]] = []
            for tu in toolUses:
                tName = as_str(tu.get('name'), '')
                tInput = as_dict(tu.get('input'), {})
                tId = as_str(tu.get('id'), f'toolu_{uuid.uuid4().hex[:16]}')
                if not _toolAllowed(agent, tName) or tName == 'spawn_subagent':
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
        updateJob(jobId, {'status': 'completed', 'result': finalText[:2000]})
        if emit:
            emit(
                {
                    'type': 'subagentDone',
                    'agentId': resolvedAgentId,
                    'jobId': jobId,
                    'status': 'completed',
                    'result': finalText[:4000],
                    'isFallback': isFallback,
                }
            )
        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'completed', 'result': finalText}
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
        # Cleanup isolated worktree when the agent ends (files stay separate while running)
        _cleanup_agent_worktree(session, workspace, worktree_path)
        currentSessionId.reset(token)
