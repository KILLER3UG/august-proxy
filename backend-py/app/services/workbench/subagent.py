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
from typing import Callable
from app.services.tools.agentRegistry import _MAXAgentDepth, createJob, deriveChildPermissions, evaluateAgentTool, getAgent, renderAgentContext, updateJob
from app.services.workbench.context import currentSessionId

def _toolName(t: dict[str, object]) -> str:
    return t.get('name') or (t.get('function') or {}).get('name', '')

def _agentOrGeneral(agentId: str, parentAlias: str) -> dict[str, object]:
    """Return the persisted agent, or a synthetic 'general' fallback."""
    agent = getAgent(agentId)
    if agent:
        return agent
    return {'id': 'general', 'name': 'General', 'role': 'General', 'description': 'General-purpose fallback sub-agent.', 'permissions': ['all'], 'modelAlias': parentAlias, 'depth': 0, '_synthetic': True}

def _toolAllowed(agent: dict[str, object], name: str) -> bool:
    if 'all' in (agent.get('permissions') or []):
        return True
    aid = agent.get('id')
    if aid and (not agent.get('_synthetic')) and getAgent(aid):
        return bool(evaluateAgentTool(aid, name).get('allowed'))
    return True

async def executeSubAgent(session: object, agentId: str, goal: str, context: str='', emit: Callable[[dict[str, object]], None] | None=None) -> dict[str, object]:
    """Execute a sub-agent task and return ``{jobId, agentId, status, result}``."""
    from app.providers.modelResolver import resolveOrFallback
    from app.providers.routeResolver import resolveForModel
    from app.services.fallbackService import getFallback
    from app.services.toolRegistry import dispatch as dispatchTool
    from app.services.workbench.workbench import MAX_MANAGED_TOOL_ROUNDS, _callAnthropicWorkbench, _callOpenaiWorkbench, _extractText, _isAnthropicProvider, _isOpenaiProvider, _resolveModel, _resolveWorkbenchProvider, openaiToolDefinitions, toolDefinitions
    parentAlias = getattr(session, 'model', '') or ''
    agent = _agentOrGeneral(agentId, parentAlias)
    resolvedAgentId = agent.get('id') or agentId
    depth = int(agent.get('depth', 0) or 0)
    if depth >= _MAXAgentDepth:
        msg = f'Sub-agent depth cap reached ({depth} >= {_MAXAgentDepth}).'
        if emit:
            emit({'type': 'subagent_done', 'agentId': resolvedAgentId, 'status': 'blocked', 'error': msg})
        return {'agentId': resolvedAgentId, 'status': 'blocked', 'error': msg}
    job = createJob(resolvedAgentId, goal, context)
    updateJob(job['id'], {'status': 'running'})
    jobId = job['id']
    if emit:
        emit({'type': 'subagent_start', 'agentId': resolvedAgentId, 'jobId': jobId, 'name': agent.get('name', 'General'), 'role': agent.get('role', ''), 'goal': goal})
    aliasHint = agent.get('modelAlias') or parentAlias or ''
    resolution = resolveOrFallback(aliasHint, provider_hint=getattr(session, 'provider', '') or '')
    model = (resolution or {}).get('model') or aliasHint or ''
    providerName = (resolution or {}).get('provider') or ''
    isFallback = bool((resolution or {}).get('is_fallback'))
    provider = _resolveWorkbenchProvider(providerName, model)
    if not provider:
        provider = resolveForModel(model, providerName) if model else None
    fb = getFallback()
    if fb.get('enabled') and fb.get('mode') != 'off' and (fb.get('provider') or fb.get('model')):
        fbModel = fb.get('model') or model
        fbProvider = resolveForModel(fbModel, fb.get('provider') or '')
        if fbProvider:
            provider = fbProvider
            model = fbModel
            isFallback = True
            if emit:
                emit({'type': 'warning', 'kind': 'model_fallback', 'agentId': resolvedAgentId, 'message': f"Sub-agent using fallback {fb.get('provider')}/{fbModel}"})
    if not provider:
        err = 'No provider available for sub-agent.'
        if emit:
            emit({'type': 'subagent_done', 'agentId': resolvedAgentId, 'jobId': jobId, 'status': 'error', 'error': err})
        updateJob(jobId, {'status': 'failed', 'error': err})
        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'error', 'error': err}
    resolvedModel = _resolveModel(provider, model)
    agentCtx = renderAgentContext(resolvedAgentId) if not agent.get('_synthetic') else ''
    if not agentCtx:
        agentCtx = f"Agent: {agent.get('name', 'General')}\nRole: {agent.get('role', 'General')}"
    systemText = f'{agentCtx}\n\nYou are a focused sub-agent. Complete the assigned goal using the available tools, then return a concise final answer. Do not spawn further sub-agents.'
    parentId = getattr(session, 'agent_id', '') or None
    if parentId and (not agent.get('_synthetic')):
        try:
            deriveChildPermissions(parentId, resolvedAgentId)
        except Exception:
            pass
    fullTools = toolDefinitions(session)
    fullOpenaiTools = openaiToolDefinitions(session)
    allowedNames = {_toolName(t) for t in fullTools if _toolAllowed(agent, _toolName(t)) and _toolName(t) != 'spawn_subagent'}
    tools = [t for t in fullTools if _toolName(t) in allowedNames]
    openaiTools = [t for t in fullOpenaiTools if _toolName(t) in allowedNames]
    isAnthropic = _isAnthropicProvider(provider)
    isOpenai = _isOpenaiProvider(provider)

    def _subEmit(ev: dict[str, object]) -> None:
        if not emit:
            return
        if ev.get('type') == 'final_output':
            emit({'type': 'subagent_text', 'agentId': resolvedAgentId, 'jobId': jobId, 'content': ev.get('content', '')})
    messages: list[dict[str, object]] = [{'role': 'user', 'content': f'Goal: {goal}\n\nContext: {context}' if context else f'Goal: {goal}'}]
    finalText = ''
    token = currentSessionId.set(getattr(session, 'id', 'default'))
    try:
        for __ in range(MAX_MANAGED_TOOL_ROUNDS):
            if isAnthropic:
                response = await _callAnthropicWorkbench(messages, systemText, resolvedModel, tools, 'medium', provider=provider, emit=_subEmit)
            elif isOpenai:
                response = await _callOpenaiWorkbench(messages, systemText, resolvedModel, openaiTools, 'medium', provider=provider, emit=_subEmit)
            else:
                break
            if response.get('error'):
                if emit:
                    emit({'type': 'subagent_text', 'agentId': resolvedAgentId, 'jobId': jobId, 'content': f"[error] {response['error']}"})
                break
            if isAnthropic:
                contentBlocks = response.get('content', [])
                assistantMsg = {'role': 'assistant', 'content': contentBlocks}
                textContent = _extractText(contentBlocks)
                toolUses = [b for b in contentBlocks if b.get('type') == 'tool_use']
            else:
                choices = response.get('choices', [])
                choice = choices[0] if choices else {}
                msg = choice.get('message', {})
                assistantMsg = {'role': 'assistant', 'content': msg.get('content', ''), 'tool_calls': msg.get('tool_calls', [])}
                textContent = response.get('text', '')
                toolUses = response.get('tool_uses', [])
            if textContent:
                finalText += textContent
            if not toolUses:
                break
            messages.append(assistantMsg)
            toolResults: list[dict[str, object]] = []
            for tu in toolUses:
                tName = tu.get('name', '')
                tInput = tu.get('input', {}) or {}
                tId = tu.get('id', f'toolu_{uuid.uuid4().hex[:16]}')
                if not _toolAllowed(agent, tName) or tName == 'spawn_subagent':
                    result = f"[Blocked] Sub-agent not permitted to use '{tName}'."
                    status = 'blocked'
                else:
                    if emit:
                        emit({'type': 'subagent_tool_call', 'agentId': resolvedAgentId, 'jobId': jobId, 'id': tId, 'name': tName, 'input': tInput})
                    try:
                        result = await dispatchTool(tName, tInput)
                    except Exception as exc:
                        result = f'Error executing {tName}: {exc}'
                    status = 'done'
                resultStr = str(result)
                if emit:
                    emit({'type': 'subagent_tool_result', 'agentId': resolvedAgentId, 'jobId': jobId, 'id': tId, 'name': tName, 'content': resultStr[:2000], 'status': status})
                toolResults.append({'tool_use_id': tId, 'role': 'tool', 'content': resultStr})
            messages.extend(toolResults)
        updateJob(jobId, {'status': 'completed', 'result': finalText[:2000]})
        if emit:
            emit({'type': 'subagent_done', 'agentId': resolvedAgentId, 'jobId': jobId, 'status': 'completed', 'result': finalText[:4000], 'isFallback': isFallback})
        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'completed', 'result': finalText}
    except Exception as exc:
        updateJob(jobId, {'status': 'failed', 'error': str(exc)})
        if emit:
            emit({'type': 'subagent_done', 'agentId': resolvedAgentId, 'jobId': jobId, 'status': 'error', 'error': str(exc)})
        return {'jobId': jobId, 'agentId': resolvedAgentId, 'status': 'error', 'error': str(exc)}
    finally:
        currentSessionId.reset(token)