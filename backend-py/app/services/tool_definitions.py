"""
Register all built-in tool definitions into the tool registry.
"""

from __future__ import annotations

from app.services import tool_registry


async def _echo(**kwargs) -> str:
    return f"Echo: {kwargs}"


def register_all() -> None:
    """Register all core tool definitions."""

    # ── File tools ──
    tool_registry.register(
        "read_file",
        "Read a file from the filesystem.",
        _echo,
        {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    )
    tool_registry.register(
        "write_file",
        "Write content to a file.",
        _echo,
        {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]},
    )
    tool_registry.register(
        "list_directory",
        "List files and directories.",
        _echo,
        {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    )
    tool_registry.register(
        "search_files",
        "Search file contents.",
        _echo,
        {"type": "object", "properties": {"query": {"type": "string"}, "path": {"type": "string"}}, "required": ["query"]},
    )

    # ── Shell tools ──
    tool_registry.register(
        "run_command",
        "Run a shell command.",
        _echo,
        {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
    )

    # ── Web tools ──
    tool_registry.register(
        "web_fetch",
        "Fetch a URL and return its content.",
        _echo,
        {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
    )
    tool_registry.register(
        "web_search",
        "Search the web for information.",
        _echo,
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    )

    # ── Memory tools ──
    tool_registry.register(
        "memory_search",
        "Search past conversation memory.",
        _echo,
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    )
    tool_registry.register(
        "fact_search",
        "Search semantic facts.",
        _echo,
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    )
    tool_registry.register(
        "context_read",
        "Read current context/profile.",
        _echo,
        {"type": "object", "properties": {}, "required": []},
    )

    # ── Agent tools ──
    tool_registry.register(
        "spawn_subagent",
        "Dispatch a subagent for a focused task.",
        _echo,
        {
            "type": "object",
            "properties": {
                "goal": {"type": "string"},
                "context": {"type": "string"},
                "toolsets": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["goal"],
        },
    )

    # ── Skill tools ──
    tool_registry.register(
        "load_skill",
        "Load a skill's full instructions.",
        _echo,
        {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    )
    tool_registry.register(
        "list_skills",
        "List available skills with search.",
        _echo,
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": []},
    )
