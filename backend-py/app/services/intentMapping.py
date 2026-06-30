"""Intent mapping — parse user requests into actions and route to handlers.

Port of backend/services/workbench/intent-mapping.js.
"""
from __future__ import annotations
import re
from app.services.memory.brainOrchestrator import classifyTask

def mapIntent(text: str) -> dict[str, object]:
    """Parse user input into an intent with routing info."""
    intentType = classifyTask(text)
    lower = text.lower()
    filePaths = re.findall('[\\"\']?([a-zA-Z]:\\\\[^\\s\\"\']+|\\/[^\\s\\"\']+)[\\"\']?', text)
    if re.search('\\b(read|open|show|view|cat)\\b', lower) and filePaths:
        return {'type': 'read_file', 'target': filePaths[0], 'intent': intentType}
    if re.search('\\b(edit|write|change|update|modify)\\b', lower) and filePaths:
        return {'type': 'edit_file', 'target': filePaths[0], 'intent': intentType}
    if re.search('\\b(search|find|grep|lookup)\\b', lower):
        queries = re.findall('[\\"\']([^\\"\']+)[\\"\']', text)
        return {'type': 'search', 'query': queries[0] if queries else text, 'intent': intentType}
    if re.search('\\b(remember|save|store)\\b', lower):
        return {'type': 'memory_save', 'intent': intentType}
    if re.search('\\b(run|execute|bash|terminal|command)\\b', lower):
        return {'type': 'execute', 'intent': intentType}
    return {'type': 'chat', 'intent': intentType}