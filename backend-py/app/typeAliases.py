"""Shared type aliases and TypedDicts for type safety across the codebase."""

from __future__ import annotations

from typing import TypedDict

# ── Recursive JSON value type ───────────────────────────────────────────
# Use for truly dynamic JSON data where the shape is not known at compile time.
type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]

# ── Common API response shapes ──────────────────────────────────────────

class BrainConfigDict(TypedDict, total=False):
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


class AliasDict(TypedDict, total=False):
    alias: str
    targetModel: str
    targetProvider: str
    displayAlias: str


class ProviderConfigDict(TypedDict, total=False):
    id: str
    name: str
    apiFormat: str
    apiKey: str
    baseUrl: str


class WorkbenchSessionDict(TypedDict, total=False):
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
    key: str
    value: str
    updatedAt: str


class FactDict(TypedDict, total=False):
    id: int
    factKey: str
    factValue: str
    category: str
    source: str
    confidence: float
    createdAt: str
    updatedAt: str


class ProposalDict(TypedDict, total=False):
    id: int
    sessionId: str
    proposalType: str
    content: str
    status: str
    createdAt: str
    decidedAt: str | None
    decidedBy: str | None


class SessionRecord(TypedDict, total=False):
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
    id: int
    sessionId: str
    model: str
    inputTokens: int
    outputTokens: int
    contextTokens: int
    createdAt: str


class MessageDict(TypedDict, total=False):
    id: int
    sessionId: str
    role: str
    content: str
    createdAt: str


class ToolCallDict(TypedDict, total=False):
    id: str
    type: str
    function: dict[str, str]


class ProviderResponse(TypedDict, total=False):
    status: int
    body: JsonValue
    bodyJson: JsonValue
    headers: dict[str, str]


class BrowserSessionDict(TypedDict, total=False):
    id: str
    url: str
    title: str
    state: str
    createdAt: str


class BlackboardNoteDict(TypedDict, total=False):
    id: int
    sessionId: str
    agent: str
    key: str
    value: str
    priority: int
    createdAt: str
    expiresAt: str | None


class BrainEventMetaDict(TypedDict, total=False):
    """Free-form metadata attached to brain events. Most call sites
    attach a small JSON-friendly summary (counts, ids) but the shape
    is heterogeneous across subsystems, so consumers should narrow via
    `as` or runtime validation."""
    ruleId: int
    source: str
    category: str
    merged: int
    promoted: int
    deletedStale: int
    local: int
    llm: int
    skills: int
    facts: int


class ConsolidationSummaryDict(TypedDict, total=False):
    merged: int
    promoted: int
    deleted_stale: int
    heuristics: int
    durationMs: int
    errors: list[str]


class DaemonStatusDict(TypedDict, total=False):
    id: str
    name: str
    status: str
    startedAt: str
    lastHeartbeat: str | None
    extras: JsonValue
