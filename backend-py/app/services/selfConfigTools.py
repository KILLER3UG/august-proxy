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

def _ok(**fields: object) -> str:
    return json.dumps({'status': 'success', **fields}, default=str)

def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)

async def createAlias(alias: str, targetModel: str, targetProvider: str, displayAlias: str='') -> str:
    from app.services import aliasService
    try:
        entry = aliasService.createAlias(alias=alias, target_model=targetModel, target_provider=targetProvider, display_alias=displayAlias, actor='agent')
        return _ok(alias=entry)
    except (ValueError, KeyError) as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f'Failed to create alias: {exc}')

async def updateAlias(alias: str, targetModel: str | None=None, targetProvider: str | None=None) -> str:
    from app.services import aliasService
    try:
        entry = aliasService.update_alias(alias=alias, target_model=targetModel, target_provider=targetProvider, actor='agent')
        return _ok(alias=entry)
    except (ValueError, KeyError) as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f'Failed to update alias: {exc}')

async def deleteAlias(alias: str) -> str:
    from app.services import aliasService
    try:
        removed = aliasService.delete_alias(alias, actor='agent')
        if not removed:
            return _err(f"Alias '{alias}' not found")
        return _ok(deleted=True, alias=alias)
    except Exception as exc:
        return _err(f'Failed to delete alias: {exc}')

async def listAliases() -> str:
    from app.services import aliasService
    return _ok(aliases=aliasService.listAliases())

async def configureFallback(enabled: bool | None=None, mode: str | None=None, provider: str | None=None, model: str | None=None) -> str:
    from app.services import fallbackService
    try:
        fb = fallbackService.configureFallback(enabled=enabled, mode=mode, provider=provider, model=model, actor='agent')
        return _ok(fallback=fb)
    except (ValueError, KeyError) as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f'Failed to configure fallback: {exc}')

async def getFallback() -> str:
    from app.services import fallbackService
    return _ok(fallback=fallbackService.getFallback())

async def createAgent(name: str, description: str='', role: str='', tools: list[str] | None=None, permissions: list[str] | None=None, modelAlias: str='', parentAgent: str='') -> str:
    from app.services.tools import agentRegistry
    try:
        agent = agentRegistry.createAgent(name=name, description=description, role=role, tools=tools, permissions=permissions, model_alias=modelAlias, parent_agent=parentAgent, actor='agent')
        return _ok(agent=agent)
    except Exception as exc:
        return _err(f'Failed to create agent: {exc}')

async def updateAgent(agentId: str, name: str | None=None, description: str | None=None, role: str | None=None, tools: list[str] | None=None, permissions: list[str] | None=None, modelAlias: str | None=None) -> str:
    from app.services.tools import agentRegistry
    updates = {k: v for k, v in {'name': name, 'description': description, 'role': role, 'tools': tools, 'permissions': permissions, 'modelAlias': modelAlias}.items() if v is not None}
    try:
        agent = agentRegistry.updateAgent(agentId, updates, actor='agent')
        if not agent:
            return _err(f"Agent '{agentId}' not found")
        return _ok(agent=agent)
    except Exception as exc:
        return _err(f'Failed to update agent: {exc}')

async def deleteAgent(agentId: str) -> str:
    from app.services.tools import agentRegistry
    try:
        removed = agentRegistry.deleteAgent(agentId, actor='agent')
        if not removed:
            return _err(f"Agent '{agentId}' not found")
        return _ok(deleted=True, agentId=agentId)
    except Exception as exc:
        return _err(f'Failed to delete agent: {exc}')

async def listAgents() -> str:
    from app.services.tools import agentRegistry
    return _ok(agents=agentRegistry.listAgents())

def register() -> None:
    """Register all self-configuration tools (alias + fallback).

    Agent tools are registered separately once the agent schema is finalised.
    """
    from app.services import toolRegistry
    toolRegistry.register('create_alias', 'Create (or upsert) a model alias mapping a name to a provider + model. The provider must be a known provider name. Validates before saving.', createAlias, {'type': 'object', 'properties': {'alias': {'type': 'string', 'description': 'The alias name to create.'}, 'targetModel': {'type': 'string', 'description': 'The underlying model id.'}, 'targetProvider': {'type': 'string', 'description': "Provider name (e.g. 'Anthropic', 'Token Router')."}, 'displayAlias': {'type': 'string', 'description': 'Optional human-readable label.'}}, 'required': ['alias', 'targetModel', 'targetProvider']})
    toolRegistry.register('update_alias', "Update an existing model alias's target model and/or provider.", updateAlias, {'type': 'object', 'properties': {'alias': {'type': 'string', 'description': 'The alias name to update.'}, 'targetModel': {'type': 'string', 'description': 'New target model id.'}, 'targetProvider': {'type': 'string', 'description': 'New provider name.'}}, 'required': ['alias']})
    toolRegistry.register('delete_alias', 'Delete a model alias by name. Use list_aliases first to find alias names.', deleteAlias, {'type': 'object', 'properties': {'alias': {'type': 'string', 'description': 'The alias name to delete.'}}, 'required': ['alias']})
    toolRegistry.register('list_aliases', 'List all configured model aliases.', listAliases, {'type': 'object', 'properties': {}, 'required': []})
    toolRegistry.register('configure_fallback', 'Configure the sub-agent fallback provider + model. Pass only the fields to change. mode is one of: off, session_only, marked_subagent_only, always.', configureFallback, {'type': 'object', 'properties': {'enabled': {'type': 'boolean', 'description': 'Enable or disable fallback.'}, 'mode': {'type': 'string', 'description': 'off | session_only | marked_subagent_only | always.'}, 'provider': {'type': 'string', 'description': 'Fallback provider name.'}, 'model': {'type': 'string', 'description': 'Fallback model id.'}}})
    toolRegistry.register('get_fallback', 'Get the current sub-agent fallback configuration.', getFallback, {'type': 'object', 'properties': {}, 'required': []})
    toolRegistry.register('create_agent', 'Create a new agent with a name, role, description, tool set, and optional model alias. The agent is persisted and immediately usable (bind it to a session or invoke it as a sub-agent).', createAgent, {'type': 'object', 'properties': {'name': {'type': 'string', 'description': 'Human-readable agent name.'}, 'description': {'type': 'string', 'description': 'What the agent does.'}, 'role': {'type': 'string', 'description': "Role label (e.g. 'Researcher')."}, 'tools': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Tool names this agent may use.'}, 'permissions': {'type': 'array', 'items': {'type': 'string'}, 'description': "Permission tokens (or ['all'])."}, 'modelAlias': {'type': 'string', 'description': 'Model alias to inherit/use.'}, 'parentAgent': {'type': 'string', 'description': 'Parent agent id (for hierarchy).'}}, 'required': ['name']})
    toolRegistry.register('update_agent', "Update an existing agent's configuration. Pass only the fields to change.", updateAgent, {'type': 'object', 'properties': {'agentId': {'type': 'string', 'description': 'The agent id to update.'}, 'name': {'type': 'string'}, 'description': {'type': 'string'}, 'role': {'type': 'string'}, 'tools': {'type': 'array', 'items': {'type': 'string'}}, 'permissions': {'type': 'array', 'items': {'type': 'string'}}, 'modelAlias': {'type': 'string'}}, 'required': ['agentId']})
    toolRegistry.register('delete_agent', 'Delete an agent by id. Use list_agents to find available agent IDs.', deleteAgent, {'type': 'object', 'properties': {'agentId': {'type': 'string', 'description': 'The agent id to delete.'}}, 'required': ['agentId']})
    toolRegistry.register('list_agents', 'List all registered agents.', listAgents, {'type': 'object', 'properties': {}, 'required': []})