"""Tool registration groups for Phase 3 modularization.

Each submodule exposes ``register()`` which registers its tools into
``tool_registry``. ``register_all()`` calls every group in order.
"""

from __future__ import annotations


def register_all() -> None:
    """Register all built-in tool groups (and external self-config/provider tools)."""
    from app.services import integration_tools, provider_setup_tool, self_config_tools
    from app.services.tool_registrations import (
        agent_tools,
        bulk_tools,
        desktop_tools,
        file_tools,
        memory_tools,
        skill_tools,
        system_tools,
        web_tools,
    )
    from app.services.tools import tool_bridges

    file_tools.register()
    web_tools.register()
    desktop_tools.register()
    memory_tools.register()
    system_tools.register()
    agent_tools.register()
    skill_tools.register()
    bulk_tools.register()
    # Bridge tools (tool_search / tool_describe / tool_call) execute real
    # handlers — advertised when progressive disclosure activates.
    tool_bridges.register()
    self_config_tools.register()
    provider_setup_tool.register()
    integration_tools.register()