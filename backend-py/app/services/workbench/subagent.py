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
from typing import Any, Callable

from app.services.tools.agent_registry import (
    _MAX_AGENT_DEPTH,
    create_job,
    derive_child_permissions,
    evaluate_agent_tool,
    get_agent,
    render_agent_context,
    update_job,
)
from app.services.workbench.context import current_session_id


def _tool_name(t: dict[str, Any]) -> str:
    return t.get("name") or (t.get("function") or {}).get("name", "")


def _agent_or_general(agent_id: str, parent_alias: str) -> dict[str, Any]:
    """Return the persisted agent, or a synthetic 'general' fallback."""
    agent = get_agent(agent_id)
    if agent:
        return agent
    return {
        "id": "general",
        "name": "General",
        "role": "General",
        "description": "General-purpose fallback sub-agent.",
        "permissions": ["all"],
        "modelAlias": parent_alias,
        "depth": 0,
        "_synthetic": True,
    }


def _tool_allowed(agent: dict[str, Any], name: str) -> bool:
    if "all" in (agent.get("permissions") or []):
        return True
    aid = agent.get("id")
    if aid and not agent.get("_synthetic") and get_agent(aid):
        return bool(evaluate_agent_tool(aid, name).get("allowed"))
    # Synthetic general fallback → allow everything.
    return True


async def execute_sub_agent(
    session: Any,
    agent_id: str,
    goal: str,
    context: str = "",
    emit: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Execute a sub-agent task and return ``{jobId, agentId, status, result}``."""
    # Lazy imports to avoid circulars with the workbench module.
    from app.providers.model_resolver import resolve_or_fallback
    from app.providers.route_resolver import resolve_for_model
    from app.services.fallback_service import get_fallback
    from app.services.tool_registry import dispatch as dispatch_tool
    from app.services.workbench.workbench import (
        MAX_MANAGED_TOOL_ROUNDS,
        _call_anthropic_workbench,
        _call_openai_workbench,
        _extract_text,
        _is_anthropic_provider,
        _is_openai_provider,
        _resolve_model,
        _resolve_workbench_provider,
        openai_tool_definitions,
        tool_definitions,
    )

    parent_alias = getattr(session, "model", "") or ""
    agent = _agent_or_general(agent_id, parent_alias)
    resolved_agent_id = agent.get("id") or agent_id

    # Depth cap
    depth = int(agent.get("depth", 0) or 0)
    if depth >= _MAX_AGENT_DEPTH:
        msg = f"Sub-agent depth cap reached ({depth} >= {_MAX_AGENT_DEPTH})."
        if emit:
            emit({"type": "subagent_done", "agentId": resolved_agent_id, "status": "blocked", "error": msg})
        return {"agentId": resolved_agent_id, "status": "blocked", "error": msg}

    job = create_job(resolved_agent_id, goal, context)
    update_job(job["id"], {"status": "running"})
    job_id = job["id"]

    if emit:
        emit({
            "type": "subagent_start",
            "agentId": resolved_agent_id,
            "jobId": job_id,
            "name": agent.get("name", "General"),
            "role": agent.get("role", ""),
            "goal": goal,
        })

    # ── Resolve model + provider ──
    alias_hint = agent.get("modelAlias") or parent_alias or ""
    resolution = resolve_or_fallback(alias_hint, provider_hint=getattr(session, "provider", "") or "")
    model = (resolution or {}).get("model") or alias_hint or ""
    provider_name = (resolution or {}).get("provider") or ""
    is_fallback = bool((resolution or {}).get("is_fallback"))

    provider = _resolve_workbench_provider(provider_name, model)
    if not provider:
        provider = resolve_for_model(model, provider_name) if model else None

    # Apply sub-agent fallback config (previously unread — now live).
    fb = get_fallback()
    if fb.get("enabled") and fb.get("mode") != "off" and (fb.get("provider") or fb.get("model")):
        fb_model = fb.get("model") or model
        fb_provider = resolve_for_model(fb_model, fb.get("provider") or "")
        if fb_provider:
            provider = fb_provider
            model = fb_model
            is_fallback = True
            if emit:
                emit({
                    "type": "warning",
                    "kind": "model_fallback",
                    "agentId": resolved_agent_id,
                    "message": f"Sub-agent using fallback {fb.get('provider')}/{fb_model}",
                })

    if not provider:
        err = "No provider available for sub-agent."
        if emit:
            emit({"type": "subagent_done", "agentId": resolved_agent_id, "jobId": job_id, "status": "error", "error": err})
        update_job(job_id, {"status": "failed", "error": err})
        return {"jobId": job_id, "agentId": resolved_agent_id, "status": "error", "error": err}

    resolved_model = _resolve_model(provider, model)

    # ── Build system prompt + tool set ──
    agent_ctx = render_agent_context(resolved_agent_id) if not agent.get("_synthetic") else ""
    if not agent_ctx:
        agent_ctx = f"Agent: {agent.get('name', 'General')}\nRole: {agent.get('role', 'General')}"
    system_text = (
        f"{agent_ctx}\n\n"
        "You are a focused sub-agent. Complete the assigned goal using the "
        "available tools, then return a concise final answer. Do not spawn "
        "further sub-agents."
    )

    # Inherit permissions for auditing/lineage (port of deriveChildAgentPermissions).
    parent_id = getattr(session, "agent_id", "") or None
    if parent_id and not agent.get("_synthetic"):
        try:
            derive_child_permissions(parent_id, resolved_agent_id)
        except Exception:
            pass

    full_tools = tool_definitions(session)
    full_openai_tools = openai_tool_definitions(session)
    # Filter to tools the agent may use; never let sub-agents spawn more sub-agents.
    allowed_names = {
        _tool_name(t) for t in full_tools
        if _tool_allowed(agent, _tool_name(t)) and _tool_name(t) != "spawn_subagent"
    }
    tools = [t for t in full_tools if _tool_name(t) in allowed_names]
    openai_tools = [t for t in full_openai_tools if _tool_name(t) in allowed_names]

    is_anthropic = _is_anthropic_provider(provider)
    is_openai = _is_openai_provider(provider)

    # Sub-emit: forward model text deltas as subagent_text; tool events are
    # emitted explicitly in the loop below.
    def _sub_emit(ev: dict[str, Any]) -> None:
        if not emit:
            return
        if ev.get("type") == "final_output":
            emit({
                "type": "subagent_text",
                "agentId": resolved_agent_id,
                "jobId": job_id,
                "content": ev.get("content", ""),
            })

    messages: list[dict[str, Any]] = [{
        "role": "user",
        "content": f"Goal: {goal}\n\nContext: {context}" if context else f"Goal: {goal}",
    }]

    final_text = ""
    token = current_session_id.set(getattr(session, "id", "default"))
    try:
        for _ in range(MAX_MANAGED_TOOL_ROUNDS):
            if is_anthropic:
                response = await _call_anthropic_workbench(
                    messages, system_text, resolved_model, tools,
                    "medium", provider=provider, emit=_sub_emit,
                )
            elif is_openai:
                response = await _call_openai_workbench(
                    messages, system_text, resolved_model, openai_tools,
                    "medium", provider=provider, emit=_sub_emit,
                )
            else:
                break

            if response.get("error"):
                if emit:
                    emit({"type": "subagent_text", "agentId": resolved_agent_id, "jobId": job_id, "content": f"[error] {response['error']}"})
                break

            # Build assistant message + extract tool uses (mirrors main loop).
            if is_anthropic:
                content_blocks = response.get("content", [])
                assistant_msg = {"role": "assistant", "content": content_blocks}
                text_content = _extract_text(content_blocks)
                tool_uses = [b for b in content_blocks if b.get("type") == "tool_use"]
            else:
                choices = response.get("choices", [])
                choice = choices[0] if choices else {}
                msg = choice.get("message", {})
                assistant_msg = {
                    "role": "assistant",
                    "content": msg.get("content", ""),
                    "tool_calls": msg.get("tool_calls", []),
                }
                text_content = response.get("text", "")
                tool_uses = response.get("tool_uses", [])

            if text_content:
                final_text += text_content

            if not tool_uses:
                break

            messages.append(assistant_msg)

            # Execute each tool call under the agent's permission set.
            tool_results: list[dict[str, Any]] = []
            for tu in tool_uses:
                t_name = tu.get("name", "")
                t_input = tu.get("input", {}) or {}
                t_id = tu.get("id", f"toolu_{uuid.uuid4().hex[:16]}")

                if not _tool_allowed(agent, t_name) or t_name == "spawn_subagent":
                    result = f"[Blocked] Sub-agent not permitted to use '{t_name}'."
                    status = "blocked"
                else:
                    if emit:
                        emit({"type": "subagent_tool_call", "agentId": resolved_agent_id, "jobId": job_id, "id": t_id, "name": t_name, "input": t_input})
                    try:
                        result = await dispatch_tool(t_name, t_input)
                    except Exception as exc:  # noqa: BLE001
                        result = f"Error executing {t_name}: {exc}"
                    status = "done"

                result_str = str(result)
                if emit:
                    emit({"type": "subagent_tool_result", "agentId": resolved_agent_id, "jobId": job_id, "id": t_id, "name": t_name, "content": result_str[:2000], "status": status})

                tool_results.append({"tool_use_id": t_id, "role": "tool", "content": result_str})

            messages.extend(tool_results)

        update_job(job_id, {"status": "completed", "result": final_text[:2000]})
        if emit:
            emit({
                "type": "subagent_done",
                "agentId": resolved_agent_id,
                "jobId": job_id,
                "status": "completed",
                "result": final_text[:4000],
                "isFallback": is_fallback,
            })
        return {"jobId": job_id, "agentId": resolved_agent_id, "status": "completed", "result": final_text}
    except Exception as exc:  # noqa: BLE001
        update_job(job_id, {"status": "failed", "error": str(exc)})
        if emit:
            emit({"type": "subagent_done", "agentId": resolved_agent_id, "jobId": job_id, "status": "error", "error": str(exc)})
        return {"jobId": job_id, "agentId": resolved_agent_id, "status": "error", "error": str(exc)}
    finally:
        current_session_id.reset(token)
