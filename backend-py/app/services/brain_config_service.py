"""
Brain Orchestrator settings-tab API service.

Reads/writes ``config.json → auxiliary.cognitive.orchestrator`` (snake_case
fields) and surfaces the camelCase ``BrainConfig`` shape the React
``BrainSettings`` page expects.

One-shot migration from legacy top-level ``brain_orchestrator`` is handled by
``cognitive_config.ensure_defaults``. Runtime readers never dual-read after
that migrate.

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

import time
from typing import cast

from app.config import settings
from app.json_narrowing import as_bool, as_int
from app.services import config_service
from app.services.cognitive_config import DEFAULT_FEATURES
from app.services.memory_store import record_config_audit
from app.services.workbench import workbench as workbenchSvc
from app.type_aliases import BrainConfigDict

boolKeys: tuple[str, ...] = (
    'enabled',
    'skillRelevanceMatch',
    'modelMemoryRead',
    'memoryAutoInject',
    'modelMemoryWrites',
    'memorySensitiveTopics',
    'subagentWorktreeIsolation',
    'cameraAccess',
    'consolidationModelSummarize',
    'preferenceRetireEnabled',
    'projectMemory',
    'projectSkills',
)
numKeys: tuple[str, ...] = (
    'maxAgentDepth',
    'maxWorkbenchToolLoops',
    'autoRouteMinSamples',
    'consolidationIntervalHours',
    'introspectionIntervalHours',
    'refineIntervalHours',
    'outcomeIntervalHours',
    'outcomeWindowDays',
    'escalationBudgetPerDay',
    'episodicRetentionDays',
    'preferenceRetireDays',
    'subagentMaxConcurrent',
    'subagentMaxIterations',
    'subagentMaxDepth',
)
floatKeys: tuple[str, ...] = ('flagRateCap',)
strKeys: tuple[str, ...] = ('titleModel', 'skillLearning', 'skillLearningJudgeModel')
allowedKeys: frozenset[str] = frozenset(boolKeys + numKeys + floatKeys + strKeys)
maxAgentDepthRange = (1, 5)
maxWorkbenchLoopsRange = (1, 500)
minSamplesRange = (1, 20)
consolidationIntervalRange = (1, 168)
escalationBudgetRange = (0, 50)
flagRateCapRange = (0.0, 0.5)
# Subagent delegation limits (Settings → Subagents panel, routers/subagent.py)
subagentMaxConcurrentRange = (1, 30)
subagentMaxIterationsRange = (5, 200)
subagentMaxDepthRange = (1, 5)
fieldTable: tuple[tuple[str, str, object, str], ...] = (
    ('enabled', 'enabled', DEFAULT_FEATURES.get('enabled', True), 'bool'),
    # The agent-jobs flag is gone: the registry job ledger is an in-memory
    # capped dict now; no feature flag ever gated it (and keeping the key in
    # allowedKeys without a field mapping made a PUT containing it KeyError).
    # Per-turn skill relevance gating (Tier-1 compact index + Tier-3
    # <relevant_skills>). Default on; AUGUST_SKILL_RELEVANCE=0 also forces off.
    ('skillRelevanceMatch', 'skill_relevance_match', True, 'bool'),
    ('maxAgentDepth', 'max_agent_depth', DEFAULT_FEATURES.get('max_agent_depth', 4), 'num'),
    # Tool-round cap: DISABLED by default (0 = unlimited) — the old 25-round
    # cap killed long legitimate runs. Set > 0 in Settings → Brain to opt in;
    # stall detection still stops genuinely spinning turns.
    ('maxWorkbenchToolLoops', 'max_workbench_tool_loops', DEFAULT_FEATURES.get('max_workbench_tool_loops', 0), 'num'),
    # Evidence-driven routing introspection: `autoRoute` /
    # `autoRouteMinWinRate` / `autoRouteWinGap` are REMOVED — no turn-loop
    # reader ever existed (the "auto-routing" claim was corrected in Part 25
    # Phase 4) and the frontend opt-in ghost is deleted with them.
    # `autoRouteMinSamples` stays: harness_self_improve prints it in the
    # flow map.
    ('autoRouteMinSamples', 'auto_route_min_samples', 3, 'num'),
    # Memory read gate: when off, the facts-recall tool (brain_query/memory_search
    # over the facts store) is not offered. Default on so the model can pull
    # memory ON DEMAND. Per-turn auto-injection is a SEPARATE flag below.
    ('modelMemoryRead', 'model_memory_read', True, 'bool'),
    # Auto-inject gate: when on, a <memory> block of facts relevant to the
    # latest turn is appended every turn (plus the names-only index in the
    # system prompt). Default OFF — memory is recalled only when the model
    # calls the read tool, per the user's design. modelMemoryRead must stay on
    # for the tool to be available.
    ('memoryAutoInject', 'memory_auto_inject', False, 'bool'),
    # Memory write door: the `remember` tool is offered to the model only while
    # this is on; sensitive-topic facts additionally need memorySensitiveTopics.
    ('modelMemoryWrites', 'model_memory_writes', True, 'bool'),
    ('memorySensitiveTopics', 'memory_sensitive_topics', False, 'bool'),
    # Camera capture: the camera_snapshot / camera_list_devices tools are
    # gated behind this; when off the tools return a policy error. Frames
    # captured during a call are transient by default — never persisted to
    # disk beyond the call lifetime, and never written to memory stores.
    ('cameraAccess', 'camera_access', False, 'bool'),
    # M4 consolidation v2: one scheduled job; cadence in hours,
    # and the Q5 model-assisted merge summarization flag (default off — each
    # merge costs one cheap-model call).
    ('consolidationIntervalHours', 'consolidation_interval_hours', 24, 'num'),
    # P2 unified learning scheduler: the introspection job's cadence, was a
    # hardcoded 6h in scheduled_introspection_loop; now config like the rest.
    ('introspectionIntervalHours', 'introspection_interval_hours', 6, 'num'),
    # The refine pass's own cadence (it rides the scheduler, not
    # consolidation, since the P5 batch); and the outcome-measurement job's
    # cadence + pre/post episode window.
    ('refineIntervalHours', 'refine_interval_hours', 24, 'num'),
    ('outcomeIntervalHours', 'outcome_interval_hours', 72, 'num'),
    ('outcomeWindowDays', 'outcome_window_days', 14, 'num'),
    ('consolidationModelSummarize', 'consolidation_model_summarize', False, 'bool'),
    # M-4: episodic_timeline retention window in days — the sweep
    # in consolidation._sweep_episodic prunes rows older than this.
    ('episodicRetentionDays', 'episodic_retention_days', 90, 'num'),
    # OQ5 (Part 21, 2026-09-04): preference-retire propose-only pass. A
    # preference fact untouched for this many days AND never quoted
    # (use_count 0) is proposed for retirement (non-destructive — a human
    # decides via the proposal). Default on, 180 d harmonizes with the 30 d
    # usage-decay half-life / 90 d episodic / 30 d automation-run windows.
    ('preferenceRetireEnabled', 'preference_retire_enabled', True, 'bool'),
    ('preferenceRetireDays', 'preference_retire_days', 180, 'num'),
    # M7 item 3: optional cheap model for session titling. Empty string =
    # fall back to the turn's own model (existing behavior).
    ('titleModel', 'title_model', '', 'str'),
    # Part 16/17 skillLearning: off = no promotion judge; extract-only
    # (ship default) = mining + promote proposals; full = also draft skill
    # bodies. Governs harness_promote.run_promotion_pass.
    ('skillLearning', 'skill_learning', 'extract-only', 'str'),
    # Dedicated judge model for the episode distiller
    # (empty = fall back to the background-review memory model, then the
    # titler resolver order — keyless gateways keep working).
    ('skillLearningJudgeModel', 'skill_learning_judge_model', '', 'str'),
    # Part 16 cost gates: tier-2 escalations per day and the max fraction of
    # scored episodes flagged to tier 2 (episode_miner.flag_top_slice).
    ('escalationBudgetPerDay', 'escalation_budget_per_day', 2, 'num'),
    ('flagRateCap', 'flag_rate_cap', 0.05, 'float'),
    # Per-project memory md files + auto-project write door.
    # Off = session_tools' remember/forget stay global-only and workbench
    # stops injecting the <project_memory> block.
    ('projectMemory', 'project_memory', True, 'bool'),
    # Workspace-scoped skills root (.aug/skills shadowing
    # bundled + agent skills). Off = catalogue falls back to agent+bundled.
    ('projectSkills', 'project_skills', True, 'bool'),
    # Global subagent delegation limits (Settings → Subagents). These are the
    # fallback the spawn path uses when a session has no per-session override
    # in its workbench metadata — the settings panel posts them with no
    # session id (routers/subagent.py GET/POST /config).
    ('subagentMaxConcurrent', 'subagent_max_concurrent', 5, 'num'),
    ('subagentMaxIterations', 'subagent_max_iterations', 50, 'num'),
    ('subagentMaxDepth', 'subagent_max_depth', 1, 'num'),
    ('subagentWorktreeIsolation', 'subagent_worktree_isolation', False, 'bool'),
)
snakeToCamel: dict[str, str] = {snake: camel for camel, snake, _d, _k in fieldTable}
camelToSnake: dict[str, str] = {camel: snake for camel, snake, _d, _k in fieldTable}
fieldKind: dict[str, str] = {camel: kind for camel, _s, _d, kind in fieldTable}


def _defaultsCamel() -> BrainConfigDict:
    """Return the full defaults dict in camelCase (matches ``BrainConfig``)."""
    raw: dict[str, object] = {}
    for camel, _snake, default, _kind in fieldTable:
        raw[camel] = default
    return cast(BrainConfigDict, raw)


def getDefaults() -> BrainConfigDict:
    """Public accessor — returns the camelCase defaults the frontend renders."""
    return _defaultsCamel()


def getDelegationLimits() -> dict[str, object]:
    """Global subagent delegation limits (Settings → Subagents), already
    clamped to the Hermes-style ranges the orchestrator enforces. One source
    of truth shared by the /api/subagents/config router and the spawn path
    (subagent_orchestrator) for sessions without a per-session override."""
    cfg = getRuntimeConfig()
    return {
        'maxConcurrent': max(1, min(30, as_int(cfg.get('subagentMaxConcurrent'), 5) or 5)),
        'maxIterations': max(5, min(200, as_int(cfg.get('subagentMaxIterations'), 50) or 50)),
        'maxDepth': max(1, min(5, as_int(cfg.get('subagentMaxDepth'), 1) or 1)),
        'worktreeIsolation': as_bool(cfg.get('subagentWorktreeIsolation'), False),
    }


_RUNTIME_TTL_S = 2.0
_runtime_cache: tuple[float, BrainConfigDict] | None = None


def getRuntimeConfig() -> BrainConfigDict:
    """Merged camelCase config for runtime readers (the routing consult).

    No session/source wrappers — just the effective values, defaults
    filled in. Memoized on a 2s TTL: this is called 5–7× per turn from the
    tool-surface and prompt paths, and each uncached call walked the whole
    cognitive tree (ensure_defaults + dict copies). Writes clear the cache,
    so a PUT is reflected immediately.
    """
    global _runtime_cache
    now = time.monotonic()
    cached = _runtime_cache
    if cached is not None and now - cached[0] < _RUNTIME_TTL_S:
        return cached[1]
    merged = _snakeToCamel(_loadPersisted())
    _runtime_cache = (now, merged)
    return merged


def _loadPersisted() -> dict[str, object]:
    """Read ``auxiliary.cognitive.orchestrator`` (snake_case). Always fresh."""
    from app.services.cognitive_config import ensure_defaults, get_cognitive

    ensure_defaults()
    tree = get_cognitive()
    val = tree.get('orchestrator')
    return dict(val) if isinstance(val, dict) else {}


def _savePersisted(snakeCfg: dict[str, object]) -> None:
    """Replace ``auxiliary.cognitive.orchestrator``; drop legacy top-level key."""
    global _runtime_cache
    _runtime_cache = None
    from app.services.cognitive_config import ensure_defaults

    ensure_defaults()
    cfg = config_service.getConfig()
    aux = cfg.get('auxiliary')
    if not isinstance(aux, dict):
        aux = {}
        cfg['auxiliary'] = aux
    cognitive = aux.get('cognitive')
    if not isinstance(cognitive, dict):
        cognitive = {}
        aux['cognitive'] = cognitive
    cognitive['orchestrator'] = dict(snakeCfg)
    cfg.pop('brain_orchestrator', None)
    config_service.saveConfig(cfg)
    settings.reload()


def _snakeToCamel(snakeCfg: dict[str, object]) -> BrainConfigDict:
    """Translate a snake_case persisted dict into the camelCase response shape."""
    out = _defaultsCamel()
    for snakeKey, value in snakeCfg.items():
        camelKey = snakeToCamel.get(snakeKey)
        if camelKey is None:
            continue
        cast(dict, out)[camelKey] = value
    return out


def _camelPatchToSnake(patch: dict[str, object]) -> dict[str, object]:
    """Translate a camelCase patch (from the React form) into the snake_case
    dict we persist. Validation happens in :func:`validatePatch` first."""
    out: dict[str, object] = {}
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
        elif kind == 'str':
            if not isinstance(value, str):
                return (False, f'{key!r} must be a string (got {type(value).__name__})')
            if len(value) > 120:
                return (False, f'{key!r} must be at most 120 chars (got {len(value)})')
            if key == 'skillLearning' and value not in ('off', 'extract-only', 'full'):
                return (False, f'{key!r} must be off | extract-only | full (got {value!r})')
        elif kind == 'float':
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return (False, f'{key!r} must be a number (got {type(value).__name__})')
            lo, hi = flagRateCapRange
            if value < lo or value > hi:
                return (False, f'{key!r} must be between {lo} and {hi} (got {value})')
        else:
            if isinstance(value, bool) or not isinstance(value, int):
                return (False, f'{key!r} must be an integer (got {type(value).__name__})')
            if key == 'maxAgentDepth':
                lo, hi = maxAgentDepthRange
            elif key == 'autoRouteMinSamples':
                lo, hi = minSamplesRange
            elif key == 'consolidationIntervalHours' or key == 'introspectionIntervalHours':
                lo, hi = consolidationIntervalRange
            elif key in ('refineIntervalHours', 'outcomeIntervalHours'):
                lo, hi = consolidationIntervalRange
            elif key == 'outcomeWindowDays':
                lo, hi = (3, 90)
            elif key == 'escalationBudgetPerDay':
                lo, hi = escalationBudgetRange
            elif key == 'subagentMaxConcurrent':
                lo, hi = subagentMaxConcurrentRange
            elif key == 'subagentMaxIterations':
                lo, hi = subagentMaxIterationsRange
            elif key == 'subagentMaxDepth':
                lo, hi = subagentMaxDepthRange
            else:
                lo, hi = maxWorkbenchLoopsRange
            if value < lo or value > hi:
                return (False, f'{key!r} must be between {lo} and {hi} (got {value})')
    return (True, '')


def _sessionInfo(sessionId: str | None = None) -> dict[str, object] | None:
    """Return ``{id, task}`` for the most-recent workbench session, or ``None``
    when none exist. ``task`` is mapped from ``WorkbenchSession.goal`` because
    the dataclass has no ``task`` field (see workbench.py:41-69)."""
    try:
        sessions = workbenchSvc.listWorkbenchSessions() or []
    except Exception:
        return None
    if not sessions:
        return None
    target: dict[str, object] | None = None
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


def _resolveSource(*, forceSession: bool = False) -> str:
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


def getBrainConfigForSettings(*, sessionId: str | None = None) -> dict[str, object]:
    """Shape returned to the React ``useQuery(['brain-config'])`` call.

    Always includes the full default set so the UI can render a meaningful
    diff in the "Use chat defaults" / "Reset" buttons.
    """
    persistedSnake = _loadPersisted()
    source = _resolveSource()
    sess = _sessionInfo(sessionId)
    return {
        'source': source,
        'config': _snakeToCamel(persistedSnake),
        'defaults': _defaultsCamel(),
        'sessionId': sess['id'] if sess else None,
        'session': sess,
    }


def saveBrainConfig(patch: dict[str, object]) -> tuple[bool, str, BrainConfigDict]:
    """Apply a partial camelCase patch. Returns (ok, error_message, merged)."""
    ok, err = validatePatch(patch)
    if not ok:
        return (False, err, _snakeToCamel(_loadPersisted()))
    currentSnake = _loadPersisted()
    before = dict(currentSnake)
    snakePatch = _camelPatchToSnake(patch)
    mergedSnake = {**currentSnake, **snakePatch}
    _savePersisted(mergedSnake)
    record_config_audit('brain', 'update', 'user', before=before, after=dict(mergedSnake))
    return (True, '', _snakeToCamel(mergedSnake))


def resetBrainConfig() -> tuple[bool, BrainConfigDict]:
    """Drop the persisted override entirely. Returns (ok, defaults_camel)."""
    before = _loadPersisted()
    _savePersisted({})
    record_config_audit('brain', 'reset', 'user', before=before, after={})
    return (True, _defaultsCamel())


def getBrainConfigFromSession(sessionId: str) -> dict[str, object]:
    """Return the brain config tagged ``source='session'`` for the requested
    session. Falls back to the most-recent session when ``sessionId`` is
    unknown (matches the lenient lookup in :func:`_sessionInfo`)."""
    sess = _sessionInfo(sessionId) or _sessionInfo()
    if not sess:
        return getBrainConfigForSettings()
    persistedSnake = _loadPersisted()
    return {
        'source': 'session',
        'config': _snakeToCamel(persistedSnake),
        'defaults': _defaultsCamel(),
        'sessionId': sess['id'],
        'session': sess,
    }
