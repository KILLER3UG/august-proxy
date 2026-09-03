"""Tool registration groups for Phase 3 modularization.

Each submodule exposes ``register()`` which registers its tools into
``tool_registry``. ``register_all()`` calls every group in order.
"""

from __future__ import annotations


def register_all() -> None:
    """Register all built-in tool groups (and external self-config/provider tools)."""
    from app.services import integration_tools, provider_setup_tool, self_config_tools
    from app.services.bot_mode import dm, routines
    from app.services.tool_registrations import (
        agent_tools,
        artifact_tools,
        bulk_tools,
        circuit_tools,
        desktop_tools,
        file_tools,
        harness_tools,
        media_tools,
        office_tools,
        session_tools,
        skill_tools,
        system_tools,
        web_tools,
    )
    from app.services.tools import tool_bridges

    file_tools.register()
    web_tools.register()
    desktop_tools.register()
    office_tools.register()
    # Artifact creation: decks, charts, videos, circuit schematics.
    artifact_tools.register()
    # Circuit work: component search + ngspice simulation.
    circuit_tools.register()
    # Media analysis — the sanctioned reader for images/video/audio/docs
    # (read_file's media guard redirects here).
    media_tools.register()
    session_tools.register()
    system_tools.register()
    agent_tools.register()
    skill_tools.register()
    bulk_tools.register()
    # Bot Mode routines: Bot-owned scheduled jobs + the M-11 notepad door.
    routines.register()
    # Bot Mode Phase C: the message_agent DM tool (offered only in canonical
    # Bot Chats — the per-session gate lives in workbench toolDefinitions).
    dm.register()
    # Harness self-inspection + proposals (read-only introspection; proposals
    # are filed for human review — never applied by the model).
    harness_tools.register()
    # Bridge tools (tool_search / tool_describe / tool_call) execute real
    # handlers — advertised when progressive disclosure activates.
    tool_bridges.register()
    self_config_tools.register()
    provider_setup_tool.register()
    integration_tools.register()