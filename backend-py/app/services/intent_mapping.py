"""Intent mapping — parse user requests into actions and route to handlers.

Port of backend/services/workbench/intent-mapping.js.
"""

from __future__ import annotations

import re
from typing import Any

from app.services.memory.brain_orchestrator import classify_task


def map_intent(text: str) -> dict[str, Any]:
    """Parse user input into an intent with routing info."""
    intent_type = classify_task(text)
    lower = text.lower()

    # Extract file paths
    file_paths = re.findall(r"[\"']?([a-zA-Z]:\\[^\s\"']+|\/[^\s\"']+)[\"']?", text)

    # Check for specific intents
    if re.search(r"\b(read|open|show|view|cat)\b", lower) and file_paths:
        return {"type": "read_file", "target": file_paths[0], "intent": intent_type}

    if re.search(r"\b(edit|write|change|update|modify)\b", lower) and file_paths:
        return {"type": "edit_file", "target": file_paths[0], "intent": intent_type}

    if re.search(r"\b(search|find|grep|lookup)\b", lower):
        queries = re.findall(r"[\"']([^\"']+)[\"']", text)
        return {"type": "search", "query": queries[0] if queries else text, "intent": intent_type}

    if re.search(r"\b(remember|save|store)\b", lower):
        return {"type": "memory_save", "intent": intent_type}

    if re.search(r"\b(run|execute|bash|terminal|command)\b", lower):
        return {"type": "execute", "intent": intent_type}

    return {"type": "chat", "intent": intent_type}
