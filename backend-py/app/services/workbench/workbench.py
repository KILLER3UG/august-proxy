"""
Workbench chat engine — session management, streaming chat loop,
tool execution, and plan/approval workflow.

Port of backend/services/workbench/workbench.js (3,675 lines).

Key subsystems:
- Session CRUD (create, get, list, delete, reset)
- Streaming chat loop (Anthropic and OpenAI, streaming and non-streaming)
- Tool execution dispatch (15+ tool types)
- Plan/approval gate (plan mode, pending mutations, approval tokens)
- System prompt building (3-tier cache structure)
- Effort/thinking budget resolution
- Goal system (stubbed)
- Subagent dispatch (stubbed)
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Callable

# ── Constants ─────────────────────────────────────────────────────────

MAX_MANAGED_TOOL_ROUNDS = 10
WORKBENCH_TOKEN_BUDGET = 2_000_000

# ── Session model ────────────────────────────────────────────────────


@dataclass
class WorkbenchSession:
    """In-memory representation of a workbench session.

    Persisted to disk as JSON via save_sessions().
    """
    id: str = ""
    title: str = "New Session"
    provider: str = ""
    model: str = ""
    agent_id: str = ""
    guard_mode: str = "full"  # plan / full / ask
    created_at: str = ""
    updated_at: str = ""
    started_at: str = ""
    message_count: int = 0
    mutation_count: int = 0
    workspace_path: str = ""
    goal: str = ""
    plan: dict[str, Any] | None = None
    plan_approved: bool = False
    messages: list[dict[str, Any]] = field(default_factory=list)
    pending_mutations: list[dict[str, Any]] = field(default_factory=list)
    mutation_log: list[dict[str, Any]] = field(default_factory=list)
    status: str = "idle"  # idle / streaming / awaiting_approval
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "provider": self.provider,
            "model": self.model,
            "agentId": self.agent_id,
            "guardMode": self.guard_mode,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "startedAt": self.started_at,
            "messageCount": self.message_count,
            "mutationCount": self.mutation_count,
            "workspacePath": self.workspace_path,
            "goal": self.goal,
            "plan": self.plan,
            "planApproved": self.plan_approved,
            "messages": self.messages,
            "pendingMutations": self.pending_mutations,
            "mutationLog": self.mutation_log,
            "status": self.status,
            "metadata": self.metadata,
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> WorkbenchSession:
        return WorkbenchSession(
            id=d.get("id", ""),
            title=d.get("title", "New Session"),
            provider=d.get("provider", ""),
            model=d.get("model", ""),
            agent_id=d.get("agentId", ""),
            guard_mode=d.get("guardMode", "full"),
            created_at=d.get("createdAt", ""),
            updated_at=d.get("updatedAt", ""),
            started_at=d.get("startedAt", ""),
            message_count=d.get("messageCount", 0),
            mutation_count=d.get("mutationCount", 0),
            workspace_path=d.get("workspacePath", ""),
            goal=d.get("goal", ""),
            plan=d.get("plan"),
            plan_approved=d.get("planApproved", False),
            messages=d.get("messages", []),
            pending_mutations=d.get("pendingMutations", []),
            mutation_log=d.get("mutationLog", []),
            status=d.get("status", "idle"),
            metadata=d.get("metadata", {}),
        )


# ── Session store ────────────────────────────────────────────────────

_SESSION_FILE = "workbench-sessions.json"
_sessions: dict[str, WorkbenchSession] = {}
_status_subscribers: list[Callable[[dict[str, Any]], None]] = []


def _sessions_path() -> Path:
    from app.lib.paths import data_path
    return data_path(_SESSION_FILE)


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _load_sessions() -> None:
    """Load sessions from disk."""
    path = _sessions_path()
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text("utf-8"))
        for item in data:
            session = WorkbenchSession.from_dict(item)
            _sessions[session.id] = session
    except (json.JSONDecodeError, OSError):
        pass


def save_sessions() -> None:
    """Persist all sessions to disk (keeps last 50)."""
    sorted_sessions = sorted(
        _sessions.values(),
        key=lambda s: s.updated_at,
        reverse=True,
    )[:50]
    path = _sessions_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([s.to_dict() for s in sorted_sessions], indent=2),
        "utf-8",
    )


def _emit_session_status(session_id: str) -> None:
    """Notify status subscribers of a session status change."""
    session = _sessions.get(session_id)
    if not session:
        return
    event = {
        "type": "session_status",
        "sessionId": session_id,
        "status": session.status,
        "guardMode": session.guard_mode,
        "pendingMutations": len(session.pending_mutations) > 0,
    }
    for cb in _status_subscribers:
        try:
            cb(event)
        except Exception:
            pass


# ── Session CRUD ─────────────────────────────────────────────────────


def create_workbench_session(
    provider: str = "",
    agent_id: str = "",
    guard_mode: str = "",
    task: str = "",
    goal: str = "",
) -> WorkbenchSession:
    """Create a new workbench session."""
    session_id = f"wb_{uuid.uuid4().hex[:12]}"
    now = _now()
    session = WorkbenchSession(
        id=session_id,
        provider=provider,
        agent_id=agent_id,
        guard_mode=normalize_guard_mode(guard_mode or "full"),
        goal=goal,
        created_at=now,
        updated_at=now,
        started_at=now,
    )

    if goal:
        session.goal = goal

    _sessions[session_id] = session
    save_sessions()
    _emit_session_status(session_id)
    return session


def get_workbench_session(session_id: str | None) -> WorkbenchSession | None:
    """Get a session by ID. Returns None if not found."""
    if not session_id:
        return None
    if not _sessions:
        _load_sessions()
    return _sessions.get(session_id)


def list_workbench_sessions() -> list[dict[str, Any]]:
    """Return all sessions summarized."""
    if not _sessions:
        _load_sessions()
    sorted_sessions = sorted(
        _sessions.values(),
        key=lambda s: s.updated_at,
        reverse=True,
    )
    return [summarize_session(s) for s in sorted_sessions]


def delete_workbench_session(session_id: str) -> bool:
    """Delete a session."""
    if session_id not in _sessions:
        return False
    del _sessions[session_id]
    save_sessions()
    return True


def reset_workbench_session(
    session_id: str,
    provider: str = "",
    agent_id: str = "",
) -> WorkbenchSession | None:
    """Delete and recreate a session."""
    delete_workbench_session(session_id)
    return create_workbench_session(provider=provider, agent_id=agent_id)


def summarize_session(session: WorkbenchSession) -> dict[str, Any]:
    """Return a lightweight summary of a session."""
    return {
        "id": session.id,
        "title": session.title,
        "provider": session.provider,
        "model": session.model,
        "agentId": session.agent_id,
        "guardMode": session.guard_mode,
        "goal": session.goal,
        "plan": session.plan is not None,
        "planApproved": session.plan_approved,
        "messageCount": session.message_count,
        "mutationCount": session.mutation_count,
        "status": session.status,
        "createdAt": session.created_at,
        "updatedAt": session.updated_at,
        "startedAt": session.started_at,
        "workspacePath": session.workspace_path,
    }


def get_workbench_session_status(session_id: str) -> dict[str, Any] | None:
    """Return flat status for the UI's approval banner."""
    session = _sessions.get(session_id)
    if not session:
        return None
    has_pending = len(session.pending_mutations) > 0
    return {
        "sessionId": session_id,
        "status": session.status,
        "guardMode": session.guard_mode,
        "pendingMutation": session.pending_mutations[-1] if has_pending else None,
        "plan": session.plan,
        "planApproved": session.plan_approved,
    }


def subscribe_session_status(callback: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
    """Register a session status subscriber. Returns unsubscribe function."""
    _status_subscribers.append(callback)

    def unsubscribe() -> None:
        if callback in _status_subscribers:
            _status_subscribers.remove(callback)

    return unsubscribe


# ── Guard mode ───────────────────────────────────────────────────────


def normalize_guard_mode(mode: str) -> str:
    """Normalize guard mode to one of: plan, full, ask."""
    lower = mode.strip().lower()
    if lower in ("plan", "full", "ask"):
        return lower
    return "full"


def is_plan_mode_blocked(tool_name: str, args: dict[str, Any] | None = None) -> bool:
    """Check if a tool is blocked in plan mode.

    In plan mode, the model can only use tools that are read-only
    or related to planning.
    """
    if not tool_name:
        return False

    # Allowed in plan mode
    allowed_plan_tools = {
        "read_file", "search_files", "list_directory",
        "WebSearch", "WebFetch", "web_search", "web_fetch",
        "memory_search", "fact_search", "context_read",
        "list_skills", "load_skill",
    }

    if tool_name in allowed_plan_tools:
        return False

    # Tools that are always blocked in plan mode
    blocked_plan_tools = {
        "write_file", "run_command", "bash",
        "StrReplaceEditTool", "BashTool",
    }

    return tool_name in blocked_plan_tools


# ── System prompt building ───────────────────────────────────────────


def build_system_prompt(session: WorkbenchSession) -> str:
    """Assemble the system prompt for a workbench session.

    Uses a 3-tier structure:
    - Tier 1: Hard rules (system identity, core constraints)
    - Tier 2: Tool guidance, agent guide, team skills
    - Tier 3: Volatile (session-specific context, goal, plan)
    """
    parts: list[str] = []

    # Tier 1: Hard rules
    parts.append(
        "You are August Proxy — an AI-powered development assistant. "
        "You have access to tools for file operations, web access, "
        "bash commands, and memory."
    )
    parts.append(
        "## Operational Rules\n"
        "- Always verify file paths before writing.\n"
        "- When browsing, prefer fetching text content directly.\n"
        "- If a tool fails, retry with corrected parameters.\n"
        "- Respect user privacy and data boundaries.\n"
    )

    # Guard mode
    if session.guard_mode == "plan":
        parts.append(
            "## Plan Mode\n"
            "You are in plan mode. Create a plan first using submitPlan, "
            "then get it approved before making any changes."
        )
    elif session.guard_mode == "ask":
        parts.append(
            "## Approval Required\n"
            "File writes and command execution require user approval. "
            "Present the intended changes clearly."
        )

    # Tier 3: Volatile context
    if session.goal:
        parts.append(f"## Active Goal\n{session.goal}")

    if session.plan:
        status = " (approved)" if session.plan_approved else " (pending approval)"
        plan_text = session.plan.get("plan", json.dumps(session.plan))
        parts.append(f"## Current Plan{status}\n{plan_text}")

    return "\n\n".join(parts)


# ── Effort / thinking budget ─────────────────────────────────────────


def resolve_effective_effort(
    incoming: str | None,
    session: WorkbenchSession,
    model_entry: dict[str, Any] | None = None,
) -> str:
    """Resolve the effort level from incoming param, session, or model default."""
    if incoming and incoming in ("low", "medium", "high", "max"):
        return incoming
    if session.metadata.get("effort") in ("low", "medium", "high", "max"):
        return session.metadata["effort"]
    return "medium"


def effort_to_thinking_budget(effort: str, model_max: int = 32000, max_tokens: int = 8192) -> int:
    """Map effort to Anthropic thinking budget tokens."""
    mapping = {
        "low": min(4096, max_tokens),
        "medium": min(8192, max_tokens),
        "high": min(16000, max_tokens),
        "max": min(model_max, max_tokens * 2),
    }
    return mapping.get(effort, 8192)


def effort_to_prompt_instruction(effort: str) -> str:
    """Map effort to a system-prompt instruction."""
    instructions = {
        "low": "Provide quick, concise responses. Minimize analysis.",
        "medium": "Provide balanced responses with moderate analysis.",
        "high": "Provide thorough, detailed analysis. Take your time.",
        "max": "Provide exhaustive, comprehensive analysis. Leave nothing out.",
    }
    return instructions.get(effort, instructions["medium"])


def effort_to_openai_reasoning_effort(effort: str) -> str:
    """Map August's 4-level effort to OpenAI's 3-level reasoning_effort."""
    mapping = {
        "low": "low",
        "medium": "medium",
        "high": "high",
        "max": "high",
    }
    return mapping.get(effort, "medium")


# ── Chat loop helpers ────────────────────────────────────────────────


def tool_definitions(session: WorkbenchSession) -> list[dict[str, Any]]:
    """Return tool definitions in Anthropic format for a session."""
    from app.adapters.proxy_tools import (
        get_canonical_managed_anthropic_web_tools,
        get_managed_anthropic_web_tool_definitions,
    )
    from app.services.tool_registry import list_tools

    tools = list_tools()  # Registered tools (Anthropic format if available)

    # Add managed web tools
    web_tools = get_canonical_managed_anthropic_web_tools()
    for wt in web_tools:
        if wt["name"] not in {t.get("name", t.get("function", {}).get("name", "")) for t in tools}:
            tools.append(wt)

    return tools


def openai_tool_definitions(session: WorkbenchSession) -> list[dict[str, Any]]:
    """Return tool definitions in OpenAI format for a session."""
    from app.adapters.proxy_tools import (
        get_canonical_managed_openai_web_tools,
        anthropic_to_openai_tool_definition,
    )
    from app.services.tool_registry import list_tools

    anthropic_tools = list_tools()  # May be mixed format
    openai_tools = []
    for t in anthropic_tools:
        if t.get("type") == "function":
            openai_tools.append(t)
        else:
            openai_tools.append(anthropic_to_openai_tool_definition(t))

    return openai_tools


# ── Streaming chat loop ──────────────────────────────────────────────


async def send_workbench_message_stream(
    session_id: str,
    message: str,
    provider: str = "",
    agent_id: str = "",
    effort: str = "",
    model: str = "",
    model_provider: str = "",
    guard_mode: str = "",
    emit: Callable[[dict[str, Any]], None] | None = None,
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
    # Get or create session
    session = get_workbench_session(session_id)
    if not session:
        session = create_workbench_session(
            provider=provider,
            agent_id=agent_id,
            guard_mode=guard_mode or "full",
        )
        session_id = session.id

    # Update session properties
    if provider:
        session.provider = provider
    if agent_id:
        session.agent_id = agent_id
    if guard_mode:
        session.guard_mode = normalize_guard_mode(guard_mode)

    session.status = "streaming"
    session.updated_at = _now()
    _emit_session_status(session_id)

    # Append user message
    session.messages.append({"role": "user", "content": message})
    session.message_count += 1

    # Resolve effort
    effective_effort = resolve_effective_effort(effort or session.metadata.get("effort", ""), session)

    # Resolve provider — use modelProvider from the frontend if available,
    # since the model dropdown already knows which provider a model belongs to.
    # Fall back to resolving by model ID, then session provider.
    resolved_provider = None
    if model_provider:
        resolved_provider = _resolve_workbench_provider(model_provider, "")
    if not resolved_provider and model:
        resolved_provider = _resolve_workbench_provider("", model)
    if not resolved_provider:
        resolved_provider = _resolve_workbench_provider(session.provider, model)
    if not resolved_provider:
        resolved_provider = _resolve_workbench_provider("", "")
    resolved_model = _resolve_model(resolved_provider, model or "")

    # Emit started event
    if emit:
        emit({
            "type": "started",
            "sessionId": session_id,
            "model": resolved_model,
        })

    # Check credentials early
    if resolved_provider:
        from app.providers.clients import get_client
        client = get_client(resolved_provider)
        if client and not client.resolve_api_key():
            if emit:
                emit({"type": "error", "message": f"API key not configured for {resolved_provider.get('name', 'unknown')}"})
            session.status = "idle"
            if emit:
                emit({"type": "done", "sessionId": session_id})
            return

    # Build system prompt
    system_text = build_system_prompt(session)

    # Get adapters and tools
    tools = tool_definitions(session)
    openai_tools = openai_tool_definitions(session)

    # Determine provider format
    is_anthropic = _is_anthropic_provider(resolved_provider)
    is_openai = _is_openai_provider(resolved_provider)

    # Main chat loop
    tool_round = 0
    current_messages = list(session.messages)

    while tool_round < MAX_MANAGED_TOOL_ROUNDS:
        tool_round += 1

        if is_anthropic:
            response = await _call_anthropic_workbench(
                current_messages, system_text, resolved_model, tools,
                effective_effort, provider=resolved_provider, emit=emit,
            )
        elif is_openai:
            response = await _call_openai_workbench(
                current_messages, system_text, resolved_model, openai_tools,
                effective_effort, provider=resolved_provider, emit=emit,
            )
        else:
            if emit:
                emit({"type": "error", "message": f"Unknown provider format for {resolved_provider}"})
            break

        if response.get("error"):
            if emit:
                emit({"type": "error", "message": response["error"]})
            break

        # Extract the assistant message from the streaming response.
        # Thinking, final_output, and tool_use events were already emitted
        # progressively during streaming — only build the session message here.
        if is_anthropic:
            assistant_msg = {
                "role": "assistant",
                "content": response.get("content", []),
            }
            content_blocks = response.get("content", [])
            text_content = _extract_text(content_blocks)
            thinking_content = _extract_thinking(content_blocks)
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
            thinking_content = response.get("thinking", "")
            tool_uses = response.get("tool_uses", [])

        session.messages.append(assistant_msg)

        if not tool_uses:
            break

        # Execute tools
        tool_results: list[dict[str, Any]] = []
        for tu in tool_uses:
            tool_name = tu.get("name", "")
            tool_input = tu.get("input", {})
            tool_use_id = tu.get("id", f"toolu_{uuid.uuid4().hex[:16]}")

            # Check permissions
            blocked_reason = _check_tool_guard(session, tool_name, tool_input)
            if blocked_reason:
                if emit:
                    emit({"type": "tool_result", "name": tool_name, "error": blocked_reason, "status": "blocked"})
                tool_results.append({
                    "tool_use_id": tool_use_id,
                    "role": "tool",
                    "content": f"[Blocked] {blocked_reason}",
                })
                if session.guard_mode == "plan":
                    break
                continue

            # Execute
            if emit:
                emit({
                    "type": "tool_call",
                    "id": tool_use_id,
                    "name": tool_name,
                    "status": "running",
                })

            result = await _execute_tool(tool_name, tool_input, session)

            if emit:
                emit({
                    "type": "tool_result",
                    "id": tool_use_id,
                    "name": tool_name,
                    "summary": str(result)[:2000],
                    "status": "done",
                })

            tool_results.append({
                "tool_use_id": tool_use_id,
                "role": "tool",
                "content": result,
            })

        if not tool_results:
            break

        current_messages.append(assistant_msg)
        current_messages.extend(tool_results)

        if session.guard_mode == "plan":
            break

    session.status = "idle"
    session.updated_at = _now()
    save_sessions()
    _emit_session_status(session_id)

    if emit:
        emit({"type": "done", "sessionId": session_id})


def _resolve_workbench_provider(provider_name: str, model_hint: str = "") -> dict[str, Any] | None:
    """Resolve a provider from name or model hint."""
    from app.providers import resolver as provider_resolver

    if provider_name:
        provider = provider_resolver.resolve(provider_name)
        if provider:
            return provider
    if model_hint:
        provider = provider_resolver.resolve(model_hint)
        if provider:
            return provider
    providers = provider_resolver.list_available()
    return providers[0] if providers else None


def _resolve_model(provider: dict[str, Any] | None, model_hint: str = "") -> str:
    """Resolve the model name from hint or provider default."""
    if model_hint:
        return model_hint
    if provider:
        return provider.get("default_model", "")
    return ""


def _is_anthropic_provider(provider: dict[str, Any] | None) -> bool:
    return provider and provider.get("api_mode") == "anthropic_messages"


def _is_openai_provider(provider: dict[str, Any] | None) -> bool:
    return provider and provider.get("api_mode") in ("openai_chat", "codex_responses")


def _extract_text(content_blocks: list[dict[str, Any]]) -> str:
    """Extract text from Anthropic content blocks."""
    parts = []
    for block in content_blocks:
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts)


def _extract_thinking(content_blocks: list[dict[str, Any]]) -> str:
    """Extract thinking/reasoning from Anthropic content blocks."""
    parts = []
    for block in content_blocks:
        if block.get("type") == "thinking":
            parts.append(block.get("text", ""))
    return "\n".join(parts)


# ── Model calling ────────────────────────────────────────────────────


async def _call_anthropic_workbench(
    messages: list[dict[str, Any]],
    system_text: str,
    model: str,
    tools: list[dict[str, Any]],
    effort: str,
    provider: dict[str, Any] | None = None,
    emit: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Call an Anthropic-format model with progressive streaming.

    Emits ``thinking``, ``final_output``, and ``tool_use`` events as
    tokens arrive. Returns the full aggregated response dict with
    ``content``, ``text``, ``thinking``, and ``tool_uses`` keys.
    """
    from app.adapters.anthropic import build_anthropic_upstream_request
    from app.providers.clients import get_client

    if not provider:
        provider = _resolve_workbench_provider("", model)
    if not provider:
        return {"error": "No provider available"}

    client = get_client(provider)
    if not client:
        return {"error": f"No client for {provider.get('name')}"}

    api_key = client.resolve_api_key()
    if not api_key:
        return {"error": "API key not configured"}

    body = build_anthropic_upstream_request(
        {"messages": messages, "max_tokens": 8192},
        model,
        [{"type": "text", "text": system_text}],
    )
    if tools:
        body["tools"] = tools

    # Effort/thinking
    thinking_budget = effort_to_thinking_budget(effort)
    if thinking_budget > 0 and _supports_thinking(provider, model):
        body["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}

    # ── Stream from upstream ───────────────────────────────────────────
    content_blocks: list[dict[str, Any]] = []
    accumulated_text = ""
    accumulated_thinking = ""
    tool_uses: list[dict[str, Any]] = []
    current_tool_block: dict[str, Any] | None = None
    current_tool_input_parts: list[str] = []

    try:
        async for event in client.messages_stream(body):
            event_type = event.get("_event_type", "")

            if event_type == "content_block_start":
                block = event.get("content_block", {})
                block_type = block.get("type", "")
                if block_type == "tool_use":
                    current_tool_block = {
                        "type": "tool_use",
                        "id": block.get("id", f"toolu_{uuid.uuid4().hex[:16]}"),
                        "name": block.get("name", ""),
                        "input": {},
                    }
                    current_tool_input_parts = []
                elif block_type == "text":
                    text = block.get("text", "")
                    if text:
                        accumulated_text += text
                        if emit:
                            emit({"type": "final_output", "content": text})
                elif block_type == "thinking":
                    text = block.get("thinking", "")
                    if text:
                        accumulated_thinking += text
                        if emit:
                            emit({"type": "thinking", "content": text})

            elif event_type == "content_block_delta":
                delta = event.get("delta", {})
                delta_type = delta.get("type", "")
                if delta_type == "text_delta":
                    text = delta.get("text", "")
                    if text:
                        accumulated_text += text
                        if emit:
                            emit({"type": "final_output", "content": text})
                elif delta_type == "thinking_delta":
                    text = delta.get("thinking", "")
                    if text:
                        accumulated_thinking += text
                        if emit:
                            emit({"type": "thinking", "content": text})
                elif delta_type == "input_json_delta":
                    current_tool_input_parts.append(delta.get("partial_json", ""))

            elif event_type == "content_block_stop":
                if current_tool_block:
                    raw = "".join(current_tool_input_parts)
                    if raw:
                        try:
                            current_tool_block["input"] = json.loads(raw)
                        except json.JSONDecodeError:
                            current_tool_block["input"] = {"_raw": raw}
                    tool_uses.append(current_tool_block)
                    if emit:
                        emit({
                            "type": "tool_use",
                            "id": current_tool_block["id"],
                            "name": current_tool_block["name"],
                            "input": current_tool_block["input"],
                        })
                    current_tool_block = None
                    current_tool_input_parts = []

            elif event_type == "error":
                return {"error": f"Stream error: {event}"}

    except Exception as exc:
        return {"error": str(exc)}

    # Build content blocks preserving order
    if accumulated_thinking:
        content_blocks.append({"type": "thinking", "text": accumulated_thinking})
    if accumulated_text:
        content_blocks.append({"type": "text", "text": accumulated_text})
    content_blocks.extend(tool_uses)

    return {
        "content": content_blocks,
        "text": accumulated_text,
        "thinking": accumulated_thinking,
        "tool_uses": tool_uses,
    }


async def _call_openai_workbench(
    messages: list[dict[str, Any]],
    system_text: str,
    model: str,
    tools: list[dict[str, Any]],
    effort: str,
    provider: dict[str, Any] | None = None,
    emit: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Call an OpenAI-format model with progressive streaming.

    Emits ``thinking`` / ``reasoning`` and ``final_output`` events as
    tokens arrive. Returns the full aggregated response dict with
    ``choices`` (OpenAI format), ``text``, ``thinking``, and ``tool_uses``.
    """
    from app.providers.clients import get_client

    if not provider:
        provider = _resolve_workbench_provider("", model)
    if not provider:
        return {"error": "No provider available"}

    client = get_client(provider)
    if not client:
        return {"error": f"No client for {provider.get('name')}"}

    api_key = client.resolve_api_key()
    if not api_key:
        return {"error": "API key not configured"}

    openai_messages: list[dict[str, Any]] = [{"role": "system", "content": system_text}]
    openai_messages.extend(messages)

    body: dict[str, Any] = {
        "model": model,
        "messages": openai_messages,
        "max_tokens": 8192,
    }
    if tools:
        body["tools"] = tools

    # Reasoning effort
    reasoning = effort_to_openai_reasoning_effort(effort)
    if reasoning:
        body["reasoning_effort"] = reasoning

    # ── Stream from upstream ───────────────────────────────────────────
    content_text = ""
    thinking_text = ""
    tool_calls_accum: dict[int, dict[str, Any]] = {}
    finish_reason: str | None = None

    try:
        async for event in client.chat_completions_stream(body):
            event_type = event.get("_event_type", "")

            # OpenAI streaming sends "chat.completion.chunk" events
            if event_type not in ("chat.completion.chunk", ""):
                # Some providers omit the event type — proceed anyway
                pass

            choices = event.get("choices", [])
            if not choices:
                continue

            choice = choices[0]
            delta = choice.get("delta", {})

            # Reasoner content (thinking)
            reasoner = delta.get("reasoning_content") or delta.get("reasoning")
            if reasoner:
                thinking_text += reasoner
                if emit:
                    emit({"type": "thinking", "content": reasoner})

            # Normal text content
            text_delta = delta.get("content", "")
            if text_delta:
                content_text += text_delta
                if emit:
                    emit({"type": "final_output", "content": text_delta})

            # Tool calls
            for tc in delta.get("tool_calls", []):
                idx = tc.get("index", 0)
                if idx not in tool_calls_accum:
                    fn = tc.get("function", {})
                    tool_calls_accum[idx] = {
                        "id": tc.get("id", f"call_{uuid.uuid4().hex[:12]}"),
                        "type": "function",
                        "function": {
                            "name": fn.get("name", ""),
                            "arguments": fn.get("arguments", ""),
                        },
                    }
                else:
                    fn = tc.get("function", {})
                    existing = tool_calls_accum[idx]["function"]
                    if fn.get("arguments"):
                        existing["arguments"] += fn["arguments"]
                    if fn.get("name"):
                        existing["name"] += fn["name"]

            # Finish reason
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]

    except Exception as exc:
        return {"error": str(exc)}

    # Build OpenAI-style response
    assistant_message: dict[str, Any] = {
        "role": "assistant",
        "content": content_text,
    }

    tool_uses: list[dict[str, Any]] = []
    if tool_calls_accum:
        tc_list = []
        for idx in sorted(tool_calls_accum):
            tc = tool_calls_accum[idx]
            fn = tc["function"]
            try:
                parsed_args = json.loads(fn["arguments"]) if fn["arguments"] else {}
            except (json.JSONDecodeError, TypeError):
                parsed_args = {}
            tc_list.append({
                "id": tc["id"],
                "type": "function",
                "function": {
                    "name": fn["name"],
                    "arguments": parsed_args,
                },
            })
            tool_uses.append({
                "type": "tool_use",
                "id": tc["id"],
                "name": fn["name"],
                "input": parsed_args,
            })

            if emit:
                emit({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": fn["name"],
                    "input": parsed_args,
                })

        assistant_message["tool_calls"] = tc_list

    return {
        "choices": [{
            "index": 0,
            "message": assistant_message,
            "finish_reason": finish_reason or "stop",
        }],
        "text": content_text,
        "thinking": thinking_text,
        "tool_uses": tool_uses,
    }


def _supports_thinking(provider: dict[str, Any], model: str) -> bool:
    """Check if a provider/model supports Anthropic-style thinking."""
    profiles = provider.get("model_profiles", {})
    profile = profiles.get(model) or profiles.get("*") or {}
    return profile.get("supportsThinking", False) or profile.get("supportsReasoning", False)


# ── Tool execution dispatch ──────────────────────────────────────────


async def _execute_tool(
    tool_name: str,
    args: dict[str, Any],
    session: WorkbenchSession,
) -> str:
    """Execute a workbench tool by dispatching to the correct handler."""
    from app.services.tool_registry import dispatch as dispatch_tool

    try:
        result = await dispatch_tool(tool_name, args)
        return str(result)
    except Exception as exc:
        return f"Error: {exc}"


# ── Guard checks ─────────────────────────────────────────────────────


def _check_tool_guard(
    session: WorkbenchSession,
    tool_name: str,
    args: dict[str, Any],
) -> str | None:
    """Check if a tool execution is blocked by guard mode or permissions.

    Returns None if allowed, or a string reason if blocked.
    """
    # Plan mode blocks
    if session.guard_mode == "plan" and is_plan_mode_blocked(tool_name, args):
        return f"Tool '{tool_name}' is blocked in plan mode. Create and approve a plan first."

    return None


# ── Plan / approval ──────────────────────────────────────────────────


def submit_plan(session: WorkbenchSession, plan_data: dict[str, Any]) -> None:
    """Store a plan on the session."""
    session.plan = plan_data
    session.plan_approved = False
    session.updated_at = _now()
    _emit_session_status(session.id)


def approve_workbench_plan(session_id: str) -> bool:
    """Approve a pending plan."""
    session = _sessions.get(session_id)
    if not session or not session.plan:
        return False
    session.plan_approved = True
    session.updated_at = _now()
    save_sessions()
    _emit_session_status(session_id)
    return True


def reject_workbench_plan(session_id: str) -> bool:
    """Reject a pending plan."""
    session = _sessions.get(session_id)
    if not session:
        return False
    session.plan = None
    session.plan_approved = False
    session.updated_at = _now()
    save_sessions()
    _emit_session_status(session_id)
    return True


def record_mutation(session: WorkbenchSession, tool_name: str, args: dict[str, Any], result: str) -> None:
    """Record a mutation in the session's mutation log."""
    session.mutation_log.append({
        "toolName": tool_name,
        "args": args,
        "result": str(result)[:500],
        "timestamp": _now(),
    })
    session.mutation_count += 1


def create_pending_mutation(
    session: WorkbenchSession,
    tool_name: str,
    args: dict[str, Any],
) -> dict[str, Any] | None:
    """Create a pending mutation token requiring approval."""
    token = f"mt_{uuid.uuid4().hex[:16]}"
    mutation = {
        "token": token,
        "toolName": tool_name,
        "args": args,
        "createdAt": _now(),
        "ttl": 300,  # 5 minutes
    }
    session.pending_mutations.append(mutation)
    session.status = "awaiting_approval"
    save_sessions()
    _emit_session_status(session.id)
    return mutation


def consume_pending_mutation(token: str, reject: bool = False) -> bool:
    """Approve or reject a pending mutation."""
    for session in _sessions.values():
        for i, pm in enumerate(session.pending_mutations):
            if pm.get("token") == token:
                if reject:
                    session.pending_mutations.pop(i)
                    session.status = "idle"
                    save_sessions()
                    return True
                # Approve
                session.pending_mutations.pop(i)
                session.status = "idle"
                save_sessions()
                return True
    return False


# ── Goal system (stubbed) ────────────────────────────────────────────


def set_workbench_goal(session: WorkbenchSession, condition: str) -> None:
    """Set an active goal on the session."""
    session.goal = condition
    session.updated_at = _now()
    save_sessions()


def clear_workbench_goal(session: WorkbenchSession, reason: str = "") -> None:
    """Clear the active goal."""
    session.goal = ""
    session.updated_at = _now()
    save_sessions()


def get_workbench_goal_status(session_id: str) -> dict[str, Any] | None:
    """Return current goal status."""
    session = _sessions.get(session_id)
    if not session:
        return None
    return {"goal": session.goal, "active": bool(session.goal)}


def update_workbench_goal(
    session_id: str,
    action: str,
    condition: str = "",
) -> dict[str, Any] | None:
    """Set/clear/status for goals."""
    session = _sessions.get(session_id)
    if not session:
        return None
    if action == "set" and condition:
        set_workbench_goal(session, condition)
    elif action == "clear":
        clear_workbench_goal(session, "user requested")
    return get_workbench_goal_status(session_id)


# ── Utility functions ────────────────────────────────────────────────


def get_workbench_activity(args: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return recent workbench activity."""
    return {
        "sessions": len(_sessions),
        "active": sum(1 for s in _sessions.values() if s.status == "streaming"),
        "pending_approvals": sum(1 for s in _sessions.values() if s.status == "awaiting_approval"),
    }


def list_proxy_capabilities() -> dict[str, Any]:
    """List all tools grouped by source."""
    from app.services.tool_registry import list_tools
    return {
        "workbench_tools": list_tools(),
        "web_tools": ["WebSearch", "WebFetch", "web_search", "web_fetch"],
    }
