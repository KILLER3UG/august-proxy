"""Proxy-internal shapes that don't map to any provider API.

These models capture internal routing, classification, and state shapes
used by the proxy's tool resolution and streaming logic.
"""

from __future__ import annotations

from typing import TypedDict



class ToolClassificationResult(TypedDict, total=False):
    """Result of classifying tool calls/uses into managed and client-owned buckets."""

    has_managed: bool
    has_client_or_unknown: bool
    can_execute_managed: bool
    managed_tool_calls: list[dict[str, object]]
    client_or_unknown_tool_calls: list[dict[str, object]]
    tool_calls: list[dict[str, object]]
    managed_tool_uses: list[dict[str, object]]
    client_or_unknown_tool_uses: list[dict[str, object]]
    tool_uses: list[dict[str, object]]
