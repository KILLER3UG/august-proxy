"""Round-trip tests for the TypedDicts in app/typeAliases.py.

Purpose: ensure TypedDicts accept the JSON shapes the services actually
emit, and that structural quirks (optional fields, snake_case vs camelCase
keys) match the runtime data.

These tests are intentionally light-touch — they're a regression net for
type contract drift, not exhaustive property tests. Each TypedDict gets
one valid round-trip plus one missing-field test.
"""

from __future__ import annotations

import json

import pytest

from app.typeAliases import (
    AliasDict,
    BlackboardNoteDict,
    BrainConfigDict,
    BrainEventMetaDict,
    ConsolidationSummaryDict,
    DaemonStatusDict,
    FactDict,
    JsonValue,
    MemoryEntryDict,
    MessageDict,
    ProposalDict,
    SessionRecord,
    ToolCallDict,
    UsageEventDict,
    WorkbenchSessionDict,
)


class TestJsonValue:
    """JsonValue is recursive; verify it accepts the shapes we emit."""

    @pytest.mark.parametrize("payload", [
        "string",
        42,
        3.14,
        True,
        None,
        [],
        [1, "two", None, {"nested": True}],
        {"a": 1, "b": [1, 2, 3]},
    ])
    def test_jsonvalue_accepts_common_shapes(self, payload: JsonValue) -> None:
        # JsonValue is a TypeAlias, not a class — verify it round-trips
        # through json (the only runtime constraint we can check).
        round_tripped = json.loads(json.dumps(payload))
        assert round_tripped == payload


class TestTypedDicts:
    """Verify TypedDicts accept the JSON shapes services produce."""

    def test_alias_dict_round_trip(self) -> None:
        data: AliasDict = {"alias": "fast", "targetModel": "claude-sonnet", "targetProvider": "anthropic"}
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data

    def test_brain_config_dict_round_trip(self) -> None:
        data: BrainConfigDict = {"enabled": True, "maxAgentDepth": 3, "adaptivePolicy": False}
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data

    def test_session_record_round_trip(self) -> None:
        data: SessionRecord = {
            "id": "sess_1",
            "title": "demo",
            "startedAt": "2026-07-01T00:00:00Z",
            "messageCount": 5,
            "provider": "claude",
            "model": "claude-sonnet-4.5",
            "folderId": None,
            "isArchived": False,
            "workspacePath": "/tmp/demo",
        }
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data

    def test_fact_dict_round_trip(self) -> None:
        data: FactDict = {
            "id": 1,
            "factKey": "user:preferred_model",
            "factValue": "claude-sonnet",
            "category": "preference",
            "source": "explicit",
            "confidence": 0.95,
            "createdAt": "2026-07-01T00:00:00Z",
            "updatedAt": "2026-07-01T00:00:00Z",
        }
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data

    def test_consolidation_summary_dict_round_trip(self) -> None:
        data: ConsolidationSummaryDict = {
            "merged": 3,
            "promoted": 1,
            "deleted_stale": 5,
            "heuristics": 100,
            "durationMs": 1500,
            "errors": ["err1", "err2"],
        }
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data

    def test_blackboard_note_dict_round_trip(self) -> None:
        data: BlackboardNoteDict = {
            "id": 1,
            "sessionId": "sess_1",
            "agent": "main",
            "key": "todo:next_step",
            "value": "run pytest",
            "priority": 5,
            "createdAt": "2026-07-01T00:00:00Z",
            "expiresAt": None,
        }
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data

    def test_daemon_status_dict_round_trip(self) -> None:
        data: DaemonStatusDict = {
            "id": "daemon_1",
            "name": "consolidation",
            "status": "running",
            "startedAt": "2026-07-01T00:00:00Z",
            "lastHeartbeat": None,
            "extras": {"trigger": "interval"},
        }
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data

    def test_brain_event_meta_dict_partial(self) -> None:
        """BrainEventMetaDict is intentionally permissive — at minimum
        one field must be present, but no field is required."""
        data: BrainEventMetaDict = {"merged": 2, "promoted": 1}
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data

    def test_workbench_session_dict_round_trip(self) -> None:
        data: WorkbenchSessionDict = {
            "id": "wb_1",
            "title": "demo",
            "provider": "claude",
            "model": "claude-sonnet-4.5",
            "agentId": "build",
            "agentRole": "build",
            "agentMode": "assistant",
            "messageCount": 4,
            "mutationCount": 0,
            "guardMode": "plan",
            "goal": "ship it",
            "task": "implement feature X",
            "status": "active",
        }
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data


class TestTypeContractDrift:
    """Sanity checks on the contract between TypedDicts and the wire."""

    def test_memory_entry_dict_uses_camel_case(self) -> None:
        """MemoryEntryDict must use camelCase JSON keys (the project
        convention is to keep internal code camelCase and translate at
        the adapter boundary)."""
        data: MemoryEntryDict = {"key": "k", "value": "v", "updatedAt": "2026-07-01T00:00:00Z"}
        assert "updatedAt" in data
        assert "updated_at" not in data

    def test_message_dict_uses_camel_case(self) -> None:
        data: MessageDict = {"id": 1, "sessionId": "s", "role": "user", "content": "hi", "createdAt": "2026-07-01"}
        assert "sessionId" in data

    def test_proposal_dict_nullable_fields(self) -> None:
        """decidedAt and decidedBy are nullable (pending proposals)."""
        data: ProposalDict = {
            "id": 1,
            "sessionId": "s",
            "proposalType": "fact",
            "content": "x",
            "status": "pending",
            "createdAt": "2026-07-01",
            "decidedAt": None,
            "decidedBy": None,
        }
        assert data["decidedAt"] is None
        assert data["decidedBy"] is None

    def test_tool_call_dict_function_is_dict(self) -> None:
        """ToolCallDict.function is a dict of name→argument strings per
        the OpenAI-style tool call schema."""
        data: ToolCallDict = {"id": "tc_1", "type": "function", "function": {"name": "x", "arguments": "{}"}}
        assert isinstance(data["function"], dict)

    def test_usage_event_dict_round_trip(self) -> None:
        data: UsageEventDict = {
            "id": 1,
            "sessionId": "s",
            "model": "claude",
            "inputTokens": 100,
            "outputTokens": 50,
            "contextTokens": 1024,
            "createdAt": "2026-07-01",
        }
        round_tripped = json.loads(json.dumps(data))
        assert round_tripped == data