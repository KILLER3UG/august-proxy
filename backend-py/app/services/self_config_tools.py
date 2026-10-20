"""
Self-configuration tool handlers — alias, fallback, and agent management.

These let the model manage its own configuration through tool calls:
- ``create_alias`` / ``update_alias`` / ``delete_alias`` / ``list_aliases``
- ``configure_fallback`` / ``get_fallback``
- ``create_agent`` / ``update_agent`` / ``delete_agent`` / ``list_agents``

Each handler returns a JSON string. Mutating calls record to the config
audit log via the underlying services.
"""

from __future__ import annotations

import json
from typing import cast

from app.json_narrowing import as_str


def _ok(**fields: object) -> str:
    return json.dumps({'status': 'success', **fields}, default=str)


def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)


# An agent's capability definition — what its turns may touch, and which model
# runs them. Authored only at the human door (``PUT /api/agents/{id}``, actor='ui'),
# because these tools are callable by whichever model is talking: a turn that can
# write them can grant itself ``permissions=['all']``, strip a peer's, or repoint
# a colleague at another model. The roster never sets them, so no real flow does.
_AUTHORITY_KEYS = {'permissions': 'permissions', 'tools': 'tools', 'model_alias': 'model routing (modelAlias)'}


def _authority_refusal(provided: dict[str, object]) -> str | None:
    """Error text naming every authority field the caller tried to author, else None."""
    named = [label for key, label in _AUTHORITY_KEYS.items() if provided.get(key)]
    if not named:
        return None
    return _err(
        f"Refused: {', '.join(named)} is an agent's capability definition, which only the "
        'user can author (Settings → Agents). An agent that declares no capabilities inherits '
        'the surface of the turn that spawned it, which is normally what a delegated worker wants.',
        refused=named,
    )


async def createAlias(alias: str, target_model: str, target_provider: str, display_alias: str = '') -> str:
    from app.services import alias_service

    try:
        entry = alias_service.createAlias(
            alias=alias,
            target_model=target_model,
            target_provider=target_provider,
            display_alias=display_alias,
            actor='agent',
        )
        return _ok(alias=alias_service.alias_to_wire(entry))
    except (ValueError, KeyError) as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f'Failed to create alias: {exc}')


async def updateAlias(alias: str, target_model: str | None = None, target_provider: str | None = None) -> str:
    from app.services import alias_service

    try:
        entry = alias_service.update_alias(
            alias=alias, target_model=target_model, target_provider=target_provider, actor='agent'
        )
        return _ok(alias=alias_service.alias_to_wire(entry))
    except (ValueError, KeyError) as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f'Failed to update alias: {exc}')


async def deleteAlias(alias: str) -> str:
    from app.services import alias_service

    try:
        removed = alias_service.delete_alias(alias, actor='agent')
        if not removed:
            return _err(f"Alias '{alias}' not found")
        return _ok(deleted=True, alias=alias)
    except Exception as exc:
        return _err(f'Failed to delete alias: {exc}')


async def listAliases() -> str:
    from app.services import alias_service

    return _ok(aliases=alias_service.listAliasesWire())


async def configureFallback(
    enabled: bool | None = None, mode: str | None = None, provider: str | None = None, model: str | None = None
) -> str:
    from app.services import fallback_service

    try:
        fb = fallback_service.configureFallback(
            enabled=enabled, mode=mode, provider=provider, model=model, actor='agent'
        )
        return _ok(fallback=fb)
    except (ValueError, KeyError) as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f'Failed to configure fallback: {exc}')


async def getFallback() -> str:
    from app.services import fallback_service

    return _ok(fallback=fallback_service.getFallback())


async def createAgent(
    name: str,
    description: str = '',
    role: str = '',
    tools: list[str] | None = None,
    permissions: list[str] | None = None,
    model_alias: str = '',
    parent_agent: str = '',
) -> str:
    # Bot Mode (one agent concept): agent creation goes through the roster
    # so every agent is a Bot with a canonical chat. Idempotent on name.
    from app.services.bot_mode import roster

    refused = _authority_refusal({'permissions': permissions, 'tools': tools, 'model_alias': model_alias})
    if refused:
        return refused
    # Lineage is the HUMAN's to set, for the same reason the capability
    # definition is: `parentId` is the graph the permission ceiling walks
    # (`agent_registry._effectivePermissions`), the "may not delete an
    # ancestor" rule reads, and the "an agent with children may not be
    # deleted" rule reads. A model that could write it could re-parent a
    # stranger, shield an agent from the delete door by making it a parent,
    # and edit the very graph the ceiling is derived from. The knob is GONE
    # from the advertised schema (a knob that always refuses is a lie) and
    # refused here in case an older model still sends it.
    if parent_agent:
        return _err(
            'Refused: an agent\'s lineage (parentAgent) is the user\'s to set in Settings → '
            'Agents. A turn may create an agent, but it may not decide who that agent '
            'belongs to — the parent is what the permission ceiling and the delete rules '
            'are derived from.',
            refused=['parentAgent'],
        )

    try:
        agent = roster.create_bot(
            name=name,
            description=description,
            role=role,
            actor='agent',
        )
        return _ok(agent=agent)
    except Exception as exc:
        return _err(f'Failed to create agent: {exc}')


async def updateAgent(
    agentId: str,
    name: str | None = None,
    description: str | None = None,
    role: str | None = None,
    tools: list[str] | None = None,
    permissions: list[str] | None = None,
    model_alias: str | None = None,
) -> str:
    from app.services.tools import agent_registry

    refused = _authority_refusal({'permissions': permissions, 'tools': tools, 'model_alias': model_alias})
    if refused:
        return refused

    updates = {
        k: v
        for k, v in {
            'name': name,
            'description': description,
            'role': role,
        }.items()
        if v is not None
    }
    if not updates:
        return _err('Nothing to update: pass a name, description or role.')
    try:
        agent = agent_registry.updateAgent(agentId, cast('dict[str, object]', updates), actor='agent')
        if not agent:
            return _err(f"Agent '{agentId}' not found")
        return _ok(agent=agent)
    except Exception as exc:
        return _err(f'Failed to update agent: {exc}')


async def deleteAgent(agentId: str) -> str:
    from app.services.tools import agent_registry

    if not agent_registry.getAgent(agentId):
        return _err(f"Agent '{agentId}' not found")
    # Through the roster, not the registry: the route this tool predates. Only
    # ``roster.delete_bot`` refuses the default assistant Bot and cascades a
    # deleted Bot's private footprint (its ``bot:<id>`` facts, DM rows, room
    # memberships and canonical chat) — a bare registry delete leaves all of it
    # behind and re-mints a NEW id for `assistant` on the next boot, stranding
    # every chat bound to the old one.
    from app.services.bot_mode import roster

    default = roster.get_default_bot()
    if default and as_str(default.get('id')) == agentId:
        return _err(
            "Refused: the default assistant Bot cannot be deleted. Use a different agentId, "
            'or ask the user to remove it in Settings → Agents.'
        )
    # A turn may retire its own descendants, not the hierarchy above it: deleting
    # an ancestor orphans every agent under it, and `deleteAgent` removes rows
    # without reparenting them. Bot rooms and DM sessions run guardMode='full',
    # so the confirmation that would ask a human first is not armed for them.
    from app.services.workbench.context import currentAgentId

    callerId = currentAgentId()
    if callerId:
        if callerId == agentId:
            return _err('Refused: an agent cannot delete itself.')
        ancestor = agent_registry.getAgent(callerId)
        steps = 0
        while ancestor and steps < 8:
            if as_str(ancestor.get('id')) == agentId:
                return _err(
                    'Refused: that agent is an ancestor of the one running this turn, so deleting '
                    'it would orphan the subtree below it.'
                )
            ancestor = agent_registry.getAgent(as_str(ancestor.get('parentId')))
            steps += 1
    if any(as_str(a.get('parentId')) == agentId for a in agent_registry.listAgents()):
        return _err(
            "Refused: that agent still has children. Delete them first, or ask the user to "
            'remove the whole branch in Settings → Agents.'
        )
    try:
        removed = roster.delete_bot(agentId, actor='agent')
        if not removed:
            return _err(f"Agent '{agentId}' not found")
        return _ok(deleted=True, agentId=agentId)
    except Exception as exc:
        return _err(f'Failed to delete agent: {exc}')


async def listAgents() -> str:
    from app.services.tools import agent_registry

    return _ok(agents=agent_registry.listAgents())


async def customizeUi(changes: object = None, reset: bool = False) -> str:
    """Recolor the app's UI from chat ("make the chat input gray")."""
    from app.services import ui_customization_service

    if reset:
        applied = ui_customization_service.clearCustomization(actor='agent')
        return _ok(applied=applied, message='UI customization reset to theme defaults.')
    if not isinstance(changes, dict) or not changes:
        return _err(
            "Provide 'changes' as a token→color map, e.g. "
            '{"chatInputBackground": "gray"} or {"chatBackground": "#000000"}.'
        )
    applied, errors = ui_customization_service.replaceCustomization(changes, actor='agent')
    if errors and not applied:
        return _err('; '.join(errors))
    return _ok(
        applied=applied,
        errors=errors,
        message='UI colors updated — the app recolored live.',
    )


def register() -> None:
    """Register all self-configuration tools (alias + fallback).

    Agent tools are registered separately once the agent schema is finalised.
    """
    from app.services import tool_registry

    tool_registry.register(
        'create_alias',
        'Create (or upsert) a model alias mapping a name to a provider + model. The provider must be a known provider name. Validates before saving.',
        createAlias,
        {
            'type': 'object',
            'properties': {
                'alias': {'type': 'string', 'description': 'The alias name to create.'},
                'targetModel': {'type': 'string', 'description': 'The underlying model id.'},
                'targetProvider': {
                    'type': 'string',
                    'description': "Provider name (e.g. 'Anthropic', 'Token Router').",
                },
                'displayAlias': {'type': 'string', 'description': 'Optional human-readable label.'},
            },
            'required': ['alias', 'targetModel', 'targetProvider'],
        },
    )
    tool_registry.register(
        'update_alias',
        "Update an existing model alias's target model and/or provider.",
        updateAlias,
        {
            'type': 'object',
            'properties': {
                'alias': {'type': 'string', 'description': 'The alias name to update.'},
                'targetModel': {'type': 'string', 'description': 'New target model id.'},
                'targetProvider': {'type': 'string', 'description': 'New provider name.'},
            },
            'required': ['alias'],
        },
    )
    tool_registry.register(
        'delete_alias',
        'Delete a model alias by name. Use list_aliases first to find alias names.',
        deleteAlias,
        {
            'type': 'object',
            'properties': {'alias': {'type': 'string', 'description': 'The alias name to delete.'}},
            'required': ['alias'],
        },
    )
    tool_registry.register(
        'list_aliases',
        'List all configured model aliases.',
        listAliases,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'configure_fallback',
        'Configure the sub-agent fallback provider + model. Pass only the fields to change. mode is one of: off, session_only, marked_subagent_only, always.',
        configureFallback,
        {
            'type': 'object',
            'properties': {
                'enabled': {'type': 'boolean', 'description': 'Enable or disable fallback.'},
                'mode': {'type': 'string', 'description': 'off | session_only | marked_subagent_only | always.'},
                'provider': {'type': 'string', 'description': 'Fallback provider name.'},
                'model': {'type': 'string', 'description': 'Fallback model id.'},
            },
        },
    )
    tool_registry.register(
        'get_fallback',
        'Get the current sub-agent fallback configuration.',
        getFallback,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'customize_ui',
        "Change the app's UI colors from chat (e.g. 'make the chat area black'). "
        "Pass a token→color map (hex or named colors); reset=true restores defaults. "
        "Tokens include background, foreground, card, border, primary, accent, chatBackground, "
        "chatInputBackground, userBubble, sidebar, muted, ring.",
        customizeUi,
        {
            'type': 'object',
            'properties': {
                'changes': {
                    'type': 'object',
                    'description': 'Map of UI token id → color (hex or named). Empty/null value removes an override.',
                    'additionalProperties': {'type': 'string'},
                },
                'reset': {
                    'type': 'boolean',
                    'description': 'True to clear ALL custom colors and restore theme defaults.',
                },
            },
            'required': [],
        },
    )
    tool_registry.register(
        'create_agent',
        'Create a new agent (a Bot) with a name, role and description. The agent is persisted '
        'and immediately usable — bind it to a session or invoke it as a sub-agent. Its tool '
        'surface is inherited from the turn that spawns it; capabilities are the user to set, '
        'and so is its place in the agent hierarchy.',
        createAgent,
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Human-readable agent name.'},
                'description': {'type': 'string', 'description': 'What the agent does.'},
                'role': {'type': 'string', 'description': "Role label (e.g. 'Researcher')."},
            },
            'required': ['name'],
        },
    )
    tool_registry.register(
        'update_agent',
        "Update an existing agent's name, description or role. Pass only the fields to change. "
        "Capabilities (tools, permissions, model routing) are the user's to author in Settings.",
        updateAgent,
        {
            'type': 'object',
            'properties': {
                'agentId': {'type': 'string', 'description': 'The agent id to update.'},
                'name': {'type': 'string'},
                'description': {'type': 'string'},
                'role': {'type': 'string'},
            },
            'required': ['agentId'],
        },
    )
    tool_registry.register(
        'delete_agent',
        'Delete an agent by id. Use list_agents to find available agent IDs.',
        deleteAgent,
        {
            'type': 'object',
            'properties': {'agentId': {'type': 'string', 'description': 'The agent id to delete.'}},
            'required': ['agentId'],
        },
    )
    tool_registry.register(
        'list_agents', 'List all registered agents.', listAgents, {'type': 'object', 'properties': {}, 'required': []}
    )
