"""Shared type aliases and TypedDicts for type safety across the codebase.

Naming policy (Phase 2 B21)
===========================
TypedDict field names fall into two buckets:

**WIRE** — keys match SQLite column names, JSON config/store keys, or HTTP
response shapes that keep camelCase on the wire. Field names stay camelCase
until a later schema/rename phase (Phase 4). Half-renaming these to snake_case
while ``dict(sqlite_row)`` / file JSON still emit camelCase would lie about
runtime keys.

**INTERNAL** — pure in-memory Python structures (or config objects that
convert at a file/HTTP boundary). Fields use snake_case; load/save helpers
map to camelCase wire keys where the on-disk format still uses them.
"""

from __future__ import annotations

from typing import TypedDict

# PEP 695 ``type`` alias — requires Python 3.12+. This is intentional: the
# project targets 3.12+ (see requires-python in pyproject.toml) and CI pins
# 3.12. Pydantic 2.13+ uses PEP 695 aliases to resolve self-references.
type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, object]


# ---------------------------------------------------------------------------
# INTERNAL — snake_case fields (convert at JSON/HTTP boundary when needed)
# ---------------------------------------------------------------------------


class AliasDict(TypedDict, total=False):
    """In-memory model alias entry.

    ``config.json`` ``modelAliases`` still stores camelCase keys
    (``targetModel``, ``targetProvider``, ``displayAlias``). Convert at the
    alias_service load/save boundary via ``alias_from_wire`` / ``alias_to_wire``.
    """

    alias: str
    target_model: str
    target_provider: str
    display_alias: str


class ConsolidationSummaryDict(TypedDict, total=False):
    """Stats returned by a consolidation sleep cycle (in-process only)."""

    merged: int
    promoted: int
    deleted_stale: int
    heuristics: int
    duration_ms: int
    errors: list[str]


class DaemonStatusDict(TypedDict, total=False):
    """Compact daemon list entry from :class:`DaemonManager.list_daemons`."""

    id: str
    name: str
    status: str
    triggered: bool
    error: str | None
    last_check: float
    turns_alive: int
    output: str
    started_at: str
    last_heartbeat: str | None
    extras: JsonValue


class BrainEventMetaDict(TypedDict, total=False):
    """Free-form metadata attached to brain events. Most call sites
    attach a small JSON-friendly summary (counts, ids) but the shape
    is heterogeneous across subsystems, so consumers should narrow via
    `as` or runtime validation."""

    rule_id: int
    source: str
    category: str
    merged: int
    promoted: int
    deleted_stale: int
    local: int
    llm: int
    skills: int
    facts: int


class ProviderResponse(TypedDict, total=False):
    """Legacy TypedDict shape for provider HTTP results.

    Prefer the dataclass ``app.providers.clients.base.ProviderResponse``.
    """

    status: int
    body: JsonValue
    body_json: JsonValue
    headers: dict[str, str]


# ---------------------------------------------------------------------------
# WIRE — camelCase keys (SQLite / JSON store / API response parity)
# Wire-format keys (SQLite/JSON/API); not renamed in Phase 2.
# ---------------------------------------------------------------------------


class BrainConfigDict(TypedDict, total=False):
    """HTTP brain-settings response shape for the React BrainSettings page.

    Wire-format keys (API camelCase); not renamed in Phase 2.
    Persistence under ``config.json`` ``brain_orchestrator`` is already
    snake_case via brain_config_service fieldTable.
    """

    enabled: bool
    adaptivePolicy: bool
    failureLearning: bool
    graphMemory: bool
    agentJobs: bool
    hierarchicalAgents: bool
    adapterParallelTools: bool
    parallelReadTools: bool
    reviewLearnedGuidelines: bool
    maxAgentDepth: int
    maxWorkbenchToolLoops: int


class ProviderConfigDict(TypedDict, total=False):
    """Provider entry keys as stored in providers.json / config store.

    Wire-format keys (JSON); not renamed in Phase 2.
    """

    id: str
    name: str
    apiFormat: str
    apiKey: str
    baseUrl: str


class WorkbenchSessionDict(TypedDict, total=False):
    """Workbench session list/API shape. Wire-format keys; deferred Phase 2."""

    id: str
    title: str
    provider: str
    model: str
    agentId: str
    agentRole: str
    agentMode: str
    messageCount: int
    mutationCount: int
    guardMode: str
    goal: str
    task: str
    status: str


class MemoryEntryDict(TypedDict, total=False):
    """Wire-format keys (SQLite memoryStore); not renamed in Phase 2."""

    key: str
    value: str
    updatedAt: str


class FactDict(TypedDict, total=False):
    """Wire-format keys (SQLite facts); not renamed in Phase 2."""

    id: int
    factKey: str
    factValue: str
    category: str
    source: str
    confidence: float
    createdAt: str
    updatedAt: str


class ProposalDict(TypedDict, total=False):
    """Wire-format keys (SQLite proposals); not renamed in Phase 2."""

    id: int
    sessionId: str
    proposalType: str
    content: str
    status: str
    createdAt: str
    decidedAt: str | None
    decidedBy: str | None


class SessionRecord(TypedDict, total=False):
    """Wire-format keys (SQLite sessions); not renamed in Phase 2."""

    id: str
    title: str
    startedAt: str
    messageCount: int
    provider: str
    model: str
    folderId: str | None
    isArchived: bool
    workspacePath: str | None


class UsageEventDict(TypedDict, total=False):
    """Wire-format keys (SQLite usage); not renamed in Phase 2."""

    id: int
    sessionId: str
    model: str
    inputTokens: int
    outputTokens: int
    contextTokens: int
    createdAt: str


class MessageDict(TypedDict, total=False):
    """Wire-format keys (SQLite messages); not renamed in Phase 2."""

    id: int
    sessionId: str
    role: str
    content: str
    createdAt: str


class ToolCallDict(TypedDict, total=False):
    """OpenAI-style tool call wire shape; not renamed in Phase 2."""

    id: str
    type: str
    function: dict[str, str]


class BrowserSessionDict(TypedDict, total=False):
    """Browser session API/list shape. Wire-format keys; deferred Phase 2."""

    id: str
    url: str
    title: str
    state: str
    createdAt: str


class BlackboardNoteDict(TypedDict, total=False):
    """Wire-format keys (SQLite blackboard); not renamed in Phase 2."""

    id: int
    sessionId: str
    agent: str
    key: str
    value: str
    priority: int
    createdAt: str
    expiresAt: str | None
