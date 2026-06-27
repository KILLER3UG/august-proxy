"""
Brain orchestrator — configuration and task classification for the
August "brain" memory system.

Port of backend/services/memory/brain-orchestrator.js (255 lines).
"""

from __future__ import annotations

import re
from typing import Any

# ── Default brain features ───────────────────────────────────────────

DEFAULT_FEATURES: dict[str, Any] = {
    "enabled": True,
    "adaptive_policy": True,
    "failure_learning": True,
    "graph_memory": True,
    "agent_jobs": True,
    "hierarchical_agents": True,
    "adapter_parallel_tools": True,
    "parallel_read_tools": True,
    "max_agent_depth": 4,
    "max_workbench_tool_loops": 100,
}


def get_brain_config() -> dict[str, Any]:
    """Get the brain configuration, merging defaults with user config."""
    from app.config import settings

    cfg = settings.config
    brain_cfg = cfg.get("brain_orchestrator", {})
    if isinstance(brain_cfg, dict):
        return {**DEFAULT_FEATURES, **brain_cfg}
    return dict(DEFAULT_FEATURES)


def extract_text_from_messages(messages: list[dict[str, Any]] | None = None) -> str:
    """Extract text content from the last 8 messages."""
    if not messages:
        return ""

    texts: list[str] = []
    for msg in messages[-8:]:
        content = msg.get("content", "")
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict):
                    btype = block.get("type", "")
                    if btype == "text":
                        parts.append(block.get("text", ""))
                    elif btype == "tool_result":
                        parts.append(str(block.get("content", "")))
                    elif btype == "tool_use":
                        parts.append(f"{block.get('name', '')} {json_dumps(block.get('input', {}))}")
            texts.append("\n".join(parts))
        elif content:
            texts.append(str(content))
    return "\n".join(t for t in texts if t)


def classify_task(text: str) -> str:
    """Classify a task type from user input text."""
    value = str(text or "").lower()
    if re.search(r"fix|bug|error|failed|failing|crash|debug|diagnose|trace", value):
        return "debug"
    if re.search(r"implement|edit|write|change|refactor|patch|create|delete|move|install", value):
        return "code_edit"
    if re.search(r"search|research|latest|web|fetch|lookup|source", value):
        return "research"
    if re.search(r"remember|memory|recall|what did|last conversation|brain|jarvis", value):
        return "memory_question"
    if re.search(r"plan|architecture|design|review|compare|evaluate", value):
        return "planning"
    if re.search(r"run command|terminal|powershell|restart|docker|launch", value):
        return "system_control"
    return "chat"


def risk_for_task(task_type: str) -> str:
    """Determine risk level for a task type."""
    if task_type in ("code_edit", "system_control"):
        return "approval_required"
    return "read_only"


def policy_for_task(task_type: str, brain_config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Get execution policy for a task type."""
    if brain_config is None:
        brain_config = get_brain_config()

    base: dict[str, Any] = {
        "mode": "normal",
        "max_tokens": 2048,
        "memory_depth": "standard",
        "allow_parallel_reads": brain_config.get("parallel_read_tools", False),
        "allow_subagents": False,
        "require_plan": False,
        "require_approval": False,
        "failure_retry_limit": 2,
    }

    if task_type == "debug":
        return {**base, "mode": "debug", "max_tokens": 4096, "memory_depth": "deep", "allow_subagents": True, "failure_retry_limit": 3}
    if task_type == "code_edit":
        return {**base, "mode": "build", "max_tokens": 4096, "memory_depth": "deep", "allow_subagents": True, "require_plan": True, "require_approval": True}
    if task_type == "research":
        return {**base, "mode": "research", "max_tokens": 4096, "memory_depth": "targeted", "allow_subagents": True}
    if task_type == "memory_question":
        return {**base, "mode": "recall", "max_tokens": 3072, "memory_depth": "deep"}
    if task_type == "planning":
        return {**base, "mode": "plan", "max_tokens": 4096, "memory_depth": "standard", "allow_subagents": True}
    if task_type == "system_control":
        return {**base, "mode": "control", "max_tokens": 2048, "memory_depth": "shallow", "require_approval": True}

    return base


def json_dumps(value: Any) -> str:
    """Safe JSON serialization."""
    import json
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return str(value)
