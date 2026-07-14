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


def _ok(**fields: object) -> str:
    return json.dumps({'status': 'success', **fields}, default=str)


def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)


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
    from app.services.tools import agent_registry

    try:
        agent = agent_registry.createAgent(
            name=name,
            description=description,
            role=role,
            tools=tools,
            permissions=permissions,
            model_alias=model_alias,
            parent_agent=parent_agent,
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

    updates = {
        k: v
        for k, v in {
            'name': name,
            'description': description,
            'role': role,
            'tools': tools,
            'permissions': permissions,
            'modelAlias': model_alias,
        }.items()
        if v is not None
    }
    try:
        agent = agent_registry.updateAgent(agentId, cast('dict[str, object]', updates), actor='agent')
        if not agent:
            return _err(f"Agent '{agentId}' not found")
        return _ok(agent=agent)
    except Exception as exc:
        return _err(f'Failed to update agent: {exc}')


async def deleteAgent(agentId: str) -> str:
    from app.services.tools import agent_registry

    try:
        removed = agent_registry.deleteAgent(agentId, actor='agent')
        if not removed:
            return _err(f"Agent '{agentId}' not found")
        return _ok(deleted=True, agentId=agentId)
    except Exception as exc:
        return _err(f'Failed to delete agent: {exc}')


async def listAgents() -> str:
    from app.services.tools import agent_registry

    return _ok(agents=agent_registry.listAgents())


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
        'create_agent',
        'Create a new agent with a name, role, description, tool set, and optional model alias. The agent is persisted and immediately usable (bind it to a session or invoke it as a sub-agent).',
        createAgent,
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Human-readable agent name.'},
                'description': {'type': 'string', 'description': 'What the agent does.'},
                'role': {'type': 'string', 'description': "Role label (e.g. 'Researcher')."},
                'tools': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Tool names this agent may use.',
                },
                'permissions': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': "Permission tokens (or ['all']).",
                },
                'modelAlias': {'type': 'string', 'description': 'Model alias to inherit/use.'},
                'parentAgent': {'type': 'string', 'description': 'Parent agent id (for hierarchy).'},
            },
            'required': ['name'],
        },
    )
    tool_registry.register(
        'update_agent',
        "Update an existing agent's configuration. Pass only the fields to change.",
        updateAgent,
        {
            'type': 'object',
            'properties': {
                'agentId': {'type': 'string', 'description': 'The agent id to update.'},
                'name': {'type': 'string'},
                'description': {'type': 'string'},
                'role': {'type': 'string'},
                'tools': {'type': 'array', 'items': {'type': 'string'}},
                'permissions': {'type': 'array', 'items': {'type': 'string'}},
                'modelAlias': {'type': 'string'},
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
