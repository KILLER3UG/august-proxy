"""Tool registration groups for Phase 3 modularization.

Each submodule exposes ``register()`` which registers its tools into
``tool_registry``. ``register_all()`` calls every group in order.
"""

from __future__ import annotations


def register_all() -> None:
    """Register all built-in tool groups (and external self-config/provider tools)."""
    from app.services.tool_registrations import (
        agent_tools,
        desktop_tools,
        file_tools,
        memory_tools,
        skill_tools,
        system_tools,
        web_tools,
    )
    from app.services import self_config_tools, provider_setup_tool

    file_tools.register()
    web_tools.register()
    desktop_tools.register()
    memory_tools.register()
    system_tools.register()
    agent_tools.register()
    skill_tools.register()
    self_config_tools.register()
    provider_setup_tool.register()
