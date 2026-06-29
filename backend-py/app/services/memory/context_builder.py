"""
Context builder — builds system prompts with memory context, tool guidance,
agent context, and platform information.

Port of backend/services/memory/context-builder.js (224 lines).
"""

from __future__ import annotations

from typing import Any


AUGUST_PLATFORM: str = (
    "Platform: August Proxy.\n"
    "- Cross-session memory tools are available: memory_search() to find past conversations, "
    "fact_search() for structured facts, context_read() for user profile.\n"
    "- Save recurring user corrections/lessons as skills via `skill_manage`; load them via `load_skill`.\n"
    '- Note: "August" or "August Proxy" is the name of this proxy platform. '
    "You are still yourself — respond as your actual underlying model identity.\n"
    "- Address the user neutrally without honorifics."
)

DEFAULT_CONTEXT_MAX_CHARS: int = 24000


def is_minimax_model(model: str | None) -> bool:
    """Check if a model is a MiniMax model."""
    return isinstance(model, str) and "minimax" in model.lower()


def normalize_system_blocks(system: Any) -> list[dict[str, Any]]:
    """Normalize system prompts to a list of Anthropic content blocks."""
    if not system:
        return []
    if isinstance(system, str):
        return [{"type": "text", "text": system}]
    if isinstance(system, list):
        return [
            {"type": "text", "text": block} if isinstance(block, str) else block
            for block in system
            if block
        ]
    return [{"type": "text", "text": str(system)}]


def system_blocks_to_text(system: Any) -> str:
    """Flatten system blocks to a single text string."""
    blocks = normalize_system_blocks(system)
    parts = []
    for block in blocks:
        if isinstance(block, dict):
            if block.get("type") == "text":
                parts.append(block.get("text", "") or "")
            else:
                import json
                try:
                    parts.append(json.dumps(block))
                except (TypeError, ValueError):
                    parts.append(str(block))
        elif isinstance(block, str):
            parts.append(block)
    return "\n".join(p for p in parts if p)


def wrap_tag(tag: str, content: str, attrs: str = "") -> str:
    """Wrap content in a faux XML tag."""
    suffix = f" {attrs}" if attrs else ""
    return f"<{tag}{suffix}>\n{content or ''}\n</{tag}>"


def build_slim_core_context(memory: dict[str, Any] | None = None) -> str:
    """Build a slim core context section from memory store."""
    if not memory:
        return ""

    lines: list[str] = []
    profile = memory.get("user_profile", "")
    if profile:
        lines.append(f"User: {str(profile)[:200]}")

    context = (memory.get("global_context") or "").split("\n")
    context = [l for l in context if l][:5]
    if context:
        lines.append("Context:")
        lines.extend(f"  {l}" for l in context)

    projects = memory.get("active_projects")
    if isinstance(projects, list) and projects:
        names = [p.get("name", "") for p in projects if isinstance(p, dict)]
        if names:
            lines.append(f"Projects: {', '.join(names)}")

    # Active skills (injected by workbench.build_system_prompt)
    skills = memory.get("active_skills", "")
    if skills:
        lines.append("")
        lines.append("Active Skills:")
        lines.append(skills)

    # Phase 0: Core memory facts (fixes dead write — background_review saves
    # to 'core_memory' key but nothing reads it back into the prompt)
    core_facts = memory.get("core_memory")
    if core_facts:
        lines.append("")
        lines.append("User Facts:")
        if isinstance(core_facts, dict):
            for k, v in core_facts.items():
                lines.append(f"  {k}: {str(v)[:300]}")
        elif isinstance(core_facts, str):
            lines.append(f"  {str(core_facts)[:500]}")
        elif isinstance(core_facts, list):
            for item in core_facts[:10]:
                lines.append(f"  {str(item)[:300]}")

    return "\n".join(lines)


def build_system_prompt(
    session: dict[str, Any] | None = None,
    memory: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    agent_context: str | None = None,
) -> str:
    """Build the full system prompt for a workbench session.

    Combines platform context, memory context, agent context,
    tool guidance, and session-specific context.
    """
    parts: list[str] = [AUGUST_PLATFORM]

    # Memory context
    if memory:
        slim = build_slim_core_context(memory)
        if slim:
            parts.append(wrap_tag("memory_context", slim))

    # Agent context
    if agent_context:
        parts.append(wrap_tag("agent_context", agent_context))

    # Tool guidance
    if tools:
        from app.adapters.proxy_tools import build_client_tool_guidance
        guidance = build_client_tool_guidance(tools)
        if guidance:
            parts.append(guidance)

    # Session context
    if session:
        goal = session.get("goal", "")
        if goal:
            parts.append(f"## Active Goal\n{goal}")

        plan = session.get("plan")
        if plan:
            status = " (approved)" if session.get("planApproved") else " (pending approval)"
            plan_text = plan.get("plan", str(plan))
            parts.append(f"## Current Plan{status}\n{plan_text}")

    return "\n\n".join(parts)
