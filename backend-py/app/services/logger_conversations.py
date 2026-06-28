"""Conversation grouping — port of backend/lib/logger.js getConversations().

Groups filtered request log entries by clientType and attaches the stored
request/response details (messages, response, thinking, toolCalls,
finishReason, error) to each entry. Mirrors the Node contract consumed by
the frontend's ConversationsResponse type.
"""

from __future__ import annotations

from typing import Any

from app.services.logger import get_filtered_requests, get_request_detail


def get_conversations(period: str = "all") -> dict[str, list[dict[str, Any]]]:
    """Group request log entries by clientType, with attached details."""
    entries = get_filtered_requests(period)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        client = entry.get("clientType") or entry.get("provider") or "unknown"
        grouped.setdefault(client, [])
        req_id = entry.get("reqId") or entry.get("id") or ""
        detail = get_request_detail(req_id) if req_id else None
        messages: Any = None
        response: Any = None
        if detail:
            req_body = detail.get("request") or detail.get("requestBody")
            if isinstance(req_body, str):
                try:
                    import json
                    req_body = json.loads(req_body)
                except Exception:
                    req_body = None
            if isinstance(req_body, dict):
                if req_body.get("messages"):
                    messages = req_body["messages"]
                elif req_body.get("system"):
                    sysv = req_body["system"]
                    messages = [{"role": "system", "content": sysv if isinstance(sysv, str) else __import__("json").dumps(sysv)}]

            res_body = detail.get("response") or detail.get("responseBody")
            if isinstance(res_body, str):
                try:
                    import json
                    res_body = json.loads(res_body)
                except Exception:
                    res_body = None
            if res_body:
                response = res_body

        grouped[client].append({
            **entry,
            "details": {
                "messages": messages,
                "response": response,
                "thinking": detail.get("thinking") if detail else None,
                "toolCalls": detail.get("toolCalls") if detail else None,
                "finishReason": detail.get("finishReason") if detail else None,
                "error": detail.get("error") if detail else None,
            } if detail else None,
        })
    return grouped
