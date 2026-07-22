"""Conversation grouping — port of backend/lib/logger.js getConversations().

Groups filtered request log entries by clientType and attaches the stored
request/response details (messages, response, thinking, toolCalls,
finishReason, error) to each entry. Mirrors the Node contract consumed by
the frontend's ConversationsResponse type.
"""

from __future__ import annotations

from app.json_narrowing import as_str
from app.services.logger import getFilteredRequests, getRequestDetail


def getConversations(period: str = 'all') -> dict[str, list[dict[str, object]]]:
    """Group request log entries by clientType, with attached details."""
    entries = getFilteredRequests(period)
    grouped: dict[str, list[dict[str, object]]] = {}
    for entry in entries:
        client = as_str(entry.get('clientType'), '') or as_str(entry.get('provider'), '') or 'unknown'
        grouped.setdefault(client, [])
        reqId = as_str(entry.get('reqId'), '') or as_str(entry.get('id'), '') or ''
        detail = getRequestDetail(reqId) if reqId else None
        messages: object = None
        response: object = None
        if detail:
            reqBody = detail.get('request') or detail.get('requestBody')
            if isinstance(reqBody, str):
                try:
                    import json

                    reqBody = json.loads(reqBody)
                except Exception:
                    reqBody = None
            if isinstance(reqBody, dict):
                if reqBody.get('messages'):
                    messages = reqBody['messages']
                elif reqBody.get('system'):
                    sysv = reqBody['system']
                    messages = [
                        {'role': 'system', 'content': sysv if isinstance(sysv, str) else __import__('json').dumps(sysv)}
                    ]
            resBody = detail.get('response') or detail.get('responseBody')
            if isinstance(resBody, str):
                try:
                    import json

                    resBody = json.loads(resBody)
                except Exception:
                    resBody = None
            if resBody:
                response = resBody
        grouped[client].append(
            {
                **entry,
                'details': {
                    'messages': messages,
                    'response': response,
                    'thinking': detail.get('thinking') if detail else None,
                    'toolCalls': detail.get('toolCalls') if detail else None,
                    'finishReason': detail.get('finishReason') if detail else None,
                    'error': detail.get('error') if detail else None,
                }
                if detail
                else None,
            }
        )
    return grouped
