"""
Brain Orchestrator settings-tab API service.

Port of the deleted Node.js ``backend/services/memory/brain-orchestrator.js``
settings helpers (commit 6d61910). Reads/writes the ``brain_orchestrator``
sub-key of ``config.json`` and surfaces it to the frontend as the camelCase
``BrainConfig`` shape the React ``BrainSettings`` page expects.

Persisted key (snake_case in JSON) is the existing one used by
``app.services.memory.brain_orchestrator.get_brain_config``. The response keys
(camelCase) match the ``BrainConfig`` TypeScript interface in
``frontend/desktop/src/api/workbench.ts``.

Naming convention: this module uses camelCase for functions and local
variables (per project-wide convention). JSON wire keys and the
``brain_orchestrator`` persisted sub-key remain snake_case for backward
compatibility with the existing reader at ``brain_orchestrator.py:34``.

Response shapes (match the frontend types):

  GET  /api/brain/config
    → { source, config, defaults, sessionId?, session? }

  PUT  /api/brain/config      body: Partial<BrainConfig>
    → { ok, config, defaults }

  POST /api/brain/config/reset
    → { ok, config, defaults }

  GET  /api/brain/config/from-session?sessionId=…
    → { source, config, defaults, sessionId, session }

``source`` is one of ``"persisted" | "session" | "fallback"``.
"""
from __future__ import annotations
from app.config import settings
from app.services import configService
from app.services.memory.brainOrchestrator import DEFAULT_FEATURES
from app.services.memoryStore import recordConfigAudit
from app.services.workbench import workbench as workbenchSvc
from app.typeAliases import BrainConfigDict, JsonValue
boolKeys: tuple[str, ...] = ('enabled', 'adaptivePolicy', 'failureLearning', 'graphMemory', 'agentJobs', 'hierarchicalAgents', 'adapterParallelTools', 'parallelReadTools', 'reviewLearnedGuidelines')
numKeys: tuple[str, ...] = ('maxAgentDepth', 'maxWorkbenchToolLoops')
allowedKeys: frozenset[str] = frozenset(boolKeys + numKeys)
maxAgentDepthRange = (1, 5)
maxWorkbenchLoopsRange = (1, 500)
fieldTable: tuple[tuple[str, str, object, str], ...] = (('enabled', 'enabled', DEFAULT_FEATURES.get('enabled', True), 'bool'), ('adaptivePolicy', 'adaptive_policy', DEFAULT_FEATURES.get('adaptive_policy', True), 'bool'), ('failureLearning', 'failure_learning', DEFAULT_FEATURES.get('failure_learning', True), 'bool'), ('graphMemory', 'graph_memory', DEFAULT_FEATURES.get('graph_memory', True), 'bool'), ('agentJobs', 'agent_jobs', DEFAULT_FEATURES.get('agent_jobs', True), 'bool'), ('hierarchicalAgents', 'hierarchical_agents', DEFAULT_FEATURES.get('hierarchical_agents', True), 'bool'), ('adapterParallelTools', 'adapter_parallel_tools', DEFAULT_FEATURES.get('adapter_parallel_tools', True), 'bool'), ('parallelReadTools', 'parallel_read_tools', DEFAULT_FEATURES.get('parallel_read_tools', True), 'bool'), ('reviewLearnedGuidelines', 'review_learned_guidelines', True, 'bool'), ('maxAgentDepth', 'max_agent_depth', DEFAULT_FEATURES.get('max_agent_depth', 4), 'num'), ('maxWorkbenchToolLoops', 'max_workbench_tool_loops', DEFAULT_FEATURES.get('max_workbench_tool_loops', 100), 'num'))
snakeToCamel: dict[str, str] = {snake: camel for camel, snake, _d, _k in fieldTable}
camelToSnake: dict[str, str] = {camel: snake for camel, snake, _d, _k in fieldTable}
fieldKind: dict[str, str] = {camel: kind for camel, _s, _d, kind in fieldTable}

def _defaultsCamel() -> BrainConfigDict:
    """Return the full defaults dict in camelCase (matches ``BrainConfig``)."""
    out: BrainConfigDict = {}
    for camel, _snake, default, _kind in fieldTable:
        out[camel] = default
    return out

def getDefaults() -> BrainConfigDict:
    """Public accessor — returns the camelCase defaults the frontend renders."""
    return _defaultsCamel()

def _loadPersisted() -> dict[str, JsonValue]:
    """Read ``cfg.brain_orchestrator`` (snake_case) from disk. Always fresh."""
    cfg = configService.getConfig()
    val = cfg.get('brain_orchestrator')
    return val if isinstance(val, dict) else {}

def _savePersisted(snakeCfg: dict[str, JsonValue]) -> None:
    """Write snake_case ``cfg.brain_orchestrator`` and refresh the in-memory cache."""
    cfg = configService.getConfig()
    cfg['brain_orchestrator'] = snakeCfg
    configService.saveConfig(cfg)
    settings.reload()

def _snakeToCamel(snakeCfg: dict[str, JsonValue]) -> BrainConfigDict:
    """Translate a snake_case persisted dict into the camelCase response shape."""
    out = _defaultsCamel()
    for snakeKey, value in snakeCfg.items():
        camelKey = snakeToCamel.get(snakeKey)
        if camelKey is None:
            continue
        out[camelKey] = value
    return out

def _camelPatchToSnake(patch: dict[str, JsonValue]) -> dict[str, JsonValue]:
    """Translate a camelCase patch (from the React form) into the snake_case
    dict we persist. Validation happens in :func:`validatePatch` first."""
    out: dict[str, JsonValue] = {}
    for camelKey, value in patch.items():
        snakeKey = camelToSnake[camelKey]
        out[snakeKey] = value
    return out

def validatePatch(patch: object) -> tuple[bool, str]:
    """Return (ok, error_message). Reject non-dicts, unknown keys, wrong types
    or out-of-range numeric values."""
    if not isinstance(patch, dict):
        return (False, 'body must be a JSON object')
    for key, value in patch.items():
        if key not in allowedKeys:
            return (False, f'unknown field: {key!r} (expected one of {sorted(allowedKeys)})')
        kind = fieldKind[key]
        if kind == 'bool':
            if not isinstance(value, bool):
                return (False, f'{key!r} must be a boolean (got {type(value).__name__})')
        else:
            if isinstance(value, bool) or not isinstance(value, int):
                return (False, f'{key!r} must be an integer (got {type(value).__name__})')
            if key == 'maxAgentDepth':
                lo, hi = maxAgentDepthRange
            else:
                lo, hi = maxWorkbenchLoopsRange
            if value < lo or value > hi:
                return (False, f'{key!r} must be between {lo} and {hi} (got {value})')
    return (True, '')

def _sessionInfo(sessionId: str | None=None) -> dict[str, JsonValue] | None:
    """Return ``{id, task}`` for the most-recent workbench session, or ``None``
    when none exist. ``task`` is mapped from ``WorkbenchSession.goal`` because
    the dataclass has no ``task`` field (see workbench.py:41-69)."""
    try:
        sessions = workbenchSvc.listWorkbenchSessions() or []
    except Exception:
        return None
    if not sessions:
        return None
    target: dict[str, JsonValue] | None = None
    if sessionId:
        for s in sessions:
            if s.get('id') == sessionId:
                target = s
                break
    if target is None:
        target = sessions[0]
    if not target:
        return None
    return {'id': target.get('id', ''), 'task': target.get('goal') or None}

def _resolveSource(*, forceSession: bool=False) -> str:
    """Return the ``source`` tag for the current settings view.

    * ``forceSession=True`` is set by ``/config/from-session`` — the
      caller has explicitly asked for a session-derived view, so we always
      return ``"session"`` (the original UI banner was session-conditional).
    * Otherwise: ``"persisted"`` when overrides exist, ``"fallback"`` when
      nothing is configured and there's no recent session, ``"session"``
      when there's a recent session but no overrides (so the React banner
      "Defaults pulled from your last chat session" still shows).
    """
    if forceSession:
        return 'session'
    if _loadPersisted():
        return 'persisted'
    if _sessionInfo() is not None:
        return 'session'
    return 'fallback'

def getBrainConfigForSettings(*, sessionId: str | None=None) -> dict[str, JsonValue]:
    """Shape returned to the React ``useQuery(['brain-config'])`` call.

    Always includes the full default set so the UI can render a meaningful
    diff in the "Use chat defaults" / "Reset" buttons.
    """
    persistedSnake = _loadPersisted()
    source = _resolveSource()
    sess = _sessionInfo(sessionId)
    return {'source': source, 'config': _snakeToCamel(persistedSnake), 'defaults': _defaultsCamel(), 'sessionId': sess['id'] if sess else None, 'session': sess}

def saveBrainConfig(patch: dict[str, JsonValue]) -> tuple[bool, str, BrainConfigDict]:
    """Apply a partial camelCase patch. Returns (ok, error_message, merged)."""
    ok, err = validatePatch(patch)
    if not ok:
        return (False, err, _snakeToCamel(_loadPersisted()))
    currentSnake = _loadPersisted()
    before = dict(currentSnake)
    snakePatch = _camelPatchToSnake(patch)
    mergedSnake = {**currentSnake, **snakePatch}
    _savePersisted(mergedSnake)
    recordConfigAudit('brain', 'update', 'user', before=before, after=dict(mergedSnake))
    return (True, '', _snakeToCamel(mergedSnake))

def resetBrainConfig() -> tuple[bool, BrainConfigDict]:
    """Drop the persisted override entirely. Returns (ok, defaults_camel)."""
    before = _loadPersisted()
    cfg = configService.getConfig()
    cfg.pop('brain_orchestrator', None)
    configService.saveConfig(cfg)
    settings.reload()
    recordConfigAudit('brain', 'reset', 'user', before=before, after={})
    return (True, _defaultsCamel())

def getBrainConfigFromSession(sessionId: str) -> dict[str, JsonValue]:
    """Return the brain config tagged ``source='session'`` for the requested
    session. Falls back to the most-recent session when ``sessionId`` is
    unknown (matches the lenient lookup in :func:`_sessionInfo`)."""
    sess = _sessionInfo(sessionId) or _sessionInfo()
    if not sess:
        return getBrainConfigForSettings()
    persistedSnake = _loadPersisted()
    return {'source': 'session', 'config': _snakeToCamel(persistedSnake), 'defaults': _defaultsCamel(), 'sessionId': sess['id'], 'session': sess}