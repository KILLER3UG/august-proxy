"""Self-evolution engine — lightweight rule-based reflection after each turn.

Complement to ``background_review.py`` (which does LLM-based review).
This module runs lightweight regex-based reflection on every turn to:

1. Extract user corrections from natural language ("don't X", "prefer Y")
2. Detect tool failure patterns (>2 errors = learning opportunity)
3. Capture user preferences (name, occupation, likes) into user profile
4. Save reflections to memory_store for audit trail

The heavier LLM-based review (skill creation, memory facts) is handled
by ``background_review.py`` which runs interval-gated.
"""
from __future__ import annotations
import re
import time
from app.services.memory_store import saveMemory, getMemory
from app.services.memory.auto_memory import saveAutoMemory
_REFLECTIONKey = 'self_evolution_log'
_MAXReflections = 50
_CORRECTIONPatterns: list[tuple[re.Pattern, str]] = [(re.compile("\\bdon'?t\\s+(\\w+)"), 'behavior'), (re.compile('\\bnever\\s+(\\w+)'), 'behavior'), (re.compile('\\balways\\s+(\\w+)'), 'behavior'), (re.compile('\\bprefer\\b'), 'preference'), (re.compile('\\b(actually|instead|rather)\\b'), 'correction'), (re.compile('\\bstop\\s+\\w+ing\\b'), 'behavior')]
_PREFERENCEPatterns: list[tuple[re.Pattern, str]] = [(re.compile('my\\s+(?:name|username)\\s+is\\s+(\\w+)'), 'user_name'), (re.compile("(?:i|i'm)\\s+(?:a|an)\\s+(\\w[\\w\\s]*)"), 'user_identity'), (re.compile('i\\s+(?:work|work\\s+as)\\s+(?:a|an|at)\\s+(.+?)(?:\\.|$)'), 'user_occupation'), (re.compile('i\\s+(?:like|love|prefer)\\s+(\\w[\\w\\s]*)'), 'user_preference')]

def reflectOnTurn(messages: list[dict[str, object]], model: str='') -> dict[str, object]:
    """Run lightweight rule-based self-reflection on a completed turn.

    This runs on every turn (unlike background_review which is interval-gated).
    It extracts corrections, tool failure patterns, and user preferences
    using regex patterns — no LLM call required.

    Args:
        messages: The full conversation messages from this turn.
        model: The model name used for this turn (for audit).

    Returns:
        Dict with reflection results: learnings, guideline_updates,
        memory_updates, tool_failures, message_count.
    """
    if not messages:
        return {'reflected': False, 'reason': 'no_messages'}
    learnings: list[str] = []
    guidelineUpdates = 0
    memoryUpdates = 0
    for msg in messages:
        if msg.get('role') != 'user':
            continue
        text = str(msg.get('content', '')).lower() if isinstance(msg.get('content'), str) else ''
        for pattern, category in _CORRECTIONPatterns:
            matches = pattern.findall(text)
            for match in matches:
                learning = f"User {category}: '{match}' in: {text[:100]}"
                learnings.append(learning)
                if category == 'behavior':
                    saveAutoMemory(f'correction_{int(time.time())}', f'User prefers: {match}', category='correction', importance=0.8)
                    guidelineUpdates += 1
    toolFailures = sum((1 for m in messages if m.get('role') == 'tool' and 'Error' in str(m.get('content', ''))))
    if toolFailures > 2:
        learnings.append(f'High tool failure rate: {toolFailures} errors in this turn')
        saveAutoMemory(f'tool_failure_{int(time.time())}', {'count': toolFailures, 'suggestion': 'Review tool usage patterns'}, category='learning', importance=0.7)
        memoryUpdates += 1
    for msg in messages:
        if msg.get('role') != 'user':
            continue
        text = str(msg.get('content', '')) if isinstance(msg.get('content'), str) else ''
        for pattern, key in _PREFERENCEPatterns:
            match = pattern.search(text)
            if match:
                value = match.group(1).strip()
                profile = getMemory('userProfile') or {}
                if isinstance(profile, dict) and key not in profile:
                    profile[key] = value
                    saveMemory('userProfile', profile)
                    learnings.append(f'Learned {key}: {value}')
                    memoryUpdates += 1
    reflection = {'timestamp': time.time(), 'model': model, 'learnings': learnings, 'guideline_updates': guidelineUpdates, 'memory_updates': memoryUpdates, 'tool_failures': toolFailures, 'message_count': len(messages)}
    reflections = getMemory(_REFLECTIONKey) or []
    if not isinstance(reflections, list):
        reflections = []
    reflections.append(reflection)
    reflections = reflections[-_MAXReflections:]
    saveMemory(_REFLECTIONKey, reflections)
    return reflection