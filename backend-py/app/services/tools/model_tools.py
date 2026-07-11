"""
Model tools — assembles the tool definitions that the model sees (Phase 3).

The ``assemble_tool_defs()`` function is the orchestrator:
1. Classify tools into core + deferrable
2. BM25-score deferrable tools against conversation context → top-K pre-loaded
3. Check threshold: if deferrable tokens < 10% of context → pass-through
4. Assemble: core + preloaded + bridge tools
5. Budget check: drop auto-loaded skills first, then reduce K

This is a pure function — trivially testable.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from app.services.tools.retrieval import buildToolCatalog, searchTools, buildQueryFromMessages
from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float
AUGUST_CORE_TOOLS: frozenset[str] = frozenset({'read_file', 'write_file', 'list_directory', 'search_files', 'run_command', 'web_fetch', 'web_search', 'memory_search', 'fact_search', 'context_read', 'brain_query', 'load_skill', 'list_skills', 'skill_manage', 'spawn_subagent', 'diagnose_proxy', 'describe_environment', 'tool_search', 'tool_describe', 'tool_call', 'update_heuristics', 'update_state', 'write_scratchpad', 'spawn_daemon', 'list_daemons', 'kill_daemon', 'write_blackboard', 'read_blackboard', 'clear_blackboard', 'setup_provider'})

@dataclass
class AssemblyResult:
    toolDefs: list[dict] = field(default_factory=list)
    activated: bool = False
    preloadedTools: list[str] = field(default_factory=list)
    preloadedToolCount: int = 0
    autoLoadedSkills: list[str] = field(default_factory=list)
    autoLoadedSkillCount: int = 0
    deferredCount: int = 0
    deferredTokens: int = 0
    thresholdTokens: int = 0
_BRIDGEToolDefs: list[dict[str, object]] = [{'name': 'tool_search', 'description': "Search across ALL available tools using BM25. Use this when you need a tool you don't see listed.", 'input_schema': {'type': 'object', 'properties': {'query': {'type': 'string', 'description': 'Search query describing what you need.'}, 'limit': {'type': 'integer', 'description': 'Max results (1-10).', 'default': 5}}, 'required': ['query']}}, {'name': 'tool_describe', 'description': 'Get the full JSON schema for any tool.', 'input_schema': {'type': 'object', 'properties': {'name': {'type': 'string', 'description': 'The tool name to describe.'}}, 'required': ['name']}}, {'name': 'tool_call', 'description': "Call a tool by name with JSON arguments. Use this to invoke a tool that isn't directly visible.", 'input_schema': {'type': 'object', 'properties': {'name': {'type': 'string', 'description': 'The tool name to call.'}, 'arguments': {'type': 'string', 'description': "JSON arguments matching the tool's schema."}}, 'required': ['name', 'arguments']}}]

def _estimateToolTokens(toolDef: dict) -> int:
    """Rough estimate of how many tokens a tool schema consumes."""
    schemaStr = str(toolDef.get('input_schema', toolDef.get('parameters', {})))
    desc = toolDef.get('description', '')
    return (len(desc) + len(schemaStr)) // 4 + 20

def assembleToolDefs(allToolDefs: list[dict], contextMessages: list[dict] | None=None, coreToolNames: set[str] | None=None, contextLength: int=200000, *, thresholdPct: float=10.0, preloadK: int=10, skillIndex: list[dict] | None=None, autoPrimeJ: int=2) -> AssemblyResult:
    """Assemble the tool definitions the model will see.

    Returns an ``AssemblyResult`` with the assembled tool list and metadata.
    """
    if coreToolNames is None:
        coreToolNames = set(AUGUST_CORE_TOOLS)
    result = AssemblyResult()
    result.thresholdTokens = int(contextLength * thresholdPct / 100)
    coreDefs: list[dict] = []
    deferrableDefs: list[dict] = []
    deferrableTokens = 0
    for td in allToolDefs:
        name = td.get('name', '') if isinstance(td, dict) else ''
        if name in coreToolNames or name.startswith('mcp__'):
            coreDefs.append(td)
        else:
            deferrableDefs.append(td)
            deferrableTokens += _estimateToolTokens(td)
    result.deferredTokens = deferrableTokens
    if deferrableTokens < result.thresholdTokens or not deferrableDefs:
        result.toolDefs = coreDefs + deferrableDefs
        result.activated = False
        return result
    result.activated = True
    result.deferredCount = len(deferrableDefs)
    query = ''
    if contextMessages:
        query = buildQueryFromMessages(contextMessages)
    if query:
        catalog = buildToolCatalog(deferrableDefs)
        preloadedNames = searchTools(catalog, query, k=preloadK)
    else:
        preloadedNames = [td.get('name', '') if isinstance(td, dict) else '' for td in deferrableDefs[:preloadK]]
    result.preloadedTools = preloadedNames
    result.preloadedToolCount = len(preloadedNames)
    autoSkills: list[str] = []
    if skillIndex and query:
        from app.services.tools.retrieval import buildSkillCatalog, searchSkills
        skCatalog = buildSkillCatalog(skillIndex)
        autoSkills = searchSkills(skCatalog, query, j=autoPrimeJ)
    elif skillIndex:
        autoSkills = [s.get('name', '') if isinstance(s, dict) else str(s) for s in skillIndex[:autoPrimeJ]]
    result.autoLoadedSkills = autoSkills
    result.autoLoadedSkillCount = len(autoSkills)
    preloadedDefs: list[dict] = []
    for td in deferrableDefs:
        name = td.get('name', '') if isinstance(td, dict) else ''
        if name in preloadedNames:
            preloadedDefs.append(td)
    totalTokens = sum((_estimateToolTokens(t) for t in coreDefs))
    totalTokens += sum((_estimateToolTokens(t) for t in preloadedDefs))
    totalTokens += sum((_estimateToolTokens(t) for t in _BRIDGEToolDefs))
    if totalTokens >= result.thresholdTokens:
        result.autoLoadedSkills = []
        result.autoLoadedSkillCount = 0
    while totalTokens >= result.thresholdTokens and len(preloadedDefs) > 3:
        removed = preloadedDefs.pop()
        totalTokens -= _estimateToolTokens(removed)
        result.preloadedToolCount = len(preloadedDefs)
    result.toolDefs = coreDefs + preloadedDefs + _BRIDGEToolDefs
    return result