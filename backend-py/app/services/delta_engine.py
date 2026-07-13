"""
Delta engine — detects implicit user preferences from file edits (Phase 9b).

When the user manually edits a file the model wrote, the delta engine
computes a diff and (with consent) infers a preference rule. Results
are batched and written to learned_heuristics.

**Privacy decision (not a toggle):** opt-in via first-run prompt.
Default: No. Only after explicit consent does the engine hash/diff files.

**Local-only fallback:** Tabs vs spaces, quotes, semicolons, trailing commas
are detected locally without any API call → source="local-diff".
"""

from __future__ import annotations
import hashlib
import logging
import os
import time
from difflib import unified_diff as unifiedDiff
from app.json_narrowing import as_str
from app.services.heuristics_service import addHeuristic

logger = logging.getLogger(__name__)
_TRACKWindowSeconds = 86400
_BATCHFlushCount = 20
_BATCHFlushSeconds = 86400
_consent_granted: bool = False
_diff_queue: list[dict[str, object]] = []
_last_flush: float = time.monotonic()


def isConsentGranted() -> bool:
    """Check if the user has opted into delta engine inference."""
    return _consent_granted


def grantConsent() -> None:
    """Grant consent (called from the first-run dialog handler)."""
    global _consent_granted
    _consent_granted = True
    logger.info('Delta engine consent granted')


def revokeConsent() -> None:
    """Revoke consent."""
    global _consent_granted
    _consent_granted = False
    logger.info('Delta engine consent revoked')


_LOCALPatterns = {
    'tabs': lambda a, b: _detectTabs(a, b),
    'spaces': lambda a, b: _detectSpaces(a, b),
    'single_quotes': lambda a, b: _detectQuotes(a, b, "'"),
    'double_quotes': lambda a, b: _detectQuotes(a, b, '"'),
    'trailing_semicolons': lambda a, b: _detectTrailing(a, b, ';'),
    'trailing_commas': lambda a, b: _detectTrailing(a, b, ','),
}


def _detectTabs(original: str, edited: str) -> str | None:
    """Detect tab preference changes."""
    origTabs = original.count('\t')
    editTabs = edited.count('\t')
    if origTabs < 1 and editTabs > origTabs:
        return 'Use tabs for indentation'
    if origTabs > 0 and editTabs < origTabs:
        return 'Use spaces for indentation'
    return None


def _detectSpaces(original: str, edited: str) -> str | None:
    """Detect space-count preference."""
    origSpaces = len(original) - len(original.replace('  ', ' '))
    editSpaces = len(edited) - len(edited.replace('  ', ' '))
    if editSpaces > origSpaces:
        return 'Use more spaces for formatting'
    return None


def _detectQuotes(original: str, edited: str, quote: str) -> str | None:
    """Detect single/double quote preference."""
    origCount = original.count(quote)
    editCount = edited.count(quote)
    if editCount > origCount:
        other = '"' if quote == "'" else "'"
        return f'Use {quote}quotes instead of {other}quotes'
    return None


def _detectTrailing(original: str, edited: str, char: str) -> str | None:
    """Detect trailing punctuation preference."""

    def _countTrailing(text: str, c: str) -> int:
        return sum((1 for line in text.split('\n') if line.strip().endswith(c)))

    origC = _countTrailing(original, char)
    editC = _countTrailing(edited, char)
    if editC > origC:
        return f'Add trailing {char}'
    if origC > 0 and editC < origC:
        return f'Remove trailing {char}'
    return None


def trackWrite(filePath: str, content: str) -> None:
    """Track a write_file call by the model.

    Stores a content hash for later comparison.
    """
    hashPath = _hashPath(filePath)
    _writeHash(hashPath, content)


def checkAndDiff(filePath: str) -> list[str]:
    """Check if a file was changed externally and record diffs.

    Returns list of inferred preference rules (may be empty).
    """
    if not os.path.exists(filePath):
        return []
    hashPath = _hashPath(filePath)
    originalContent = _readHash(hashPath)
    if originalContent is None:
        return []
    with open(filePath) as f:
        currentContent = f.read()
    if currentContent == originalContent:
        return []
    inferred = _processDiff(filePath, originalContent, currentContent)
    return inferred


def flushQueue() -> list[str]:
    """Flush the diff queue and process batched diffs.

    Returns any newly inferred rules.
    """
    global _diff_queue, _last_flush
    if not _diff_queue:
        return []
    localRules: list[str] = []
    for entry in _diff_queue:
        for patternName, detector in _LOCALPatterns.items():
            try:
                rule = detector(as_str(entry.get('original'), ''), as_str(entry.get('edited'), ''))
                if rule:
                    addHeuristic(rule, source='local-diff', category='coding_style')
                    localRules.append(rule)
            except Exception:
                pass
    llmRules: list[str] = []
    if isConsentGranted():
        for entry in _diff_queue:
            try:
                rule = _inferLlmRule(entry)
                if rule:
                    addHeuristic(rule, source='delta-engine', category='coding_style')
                    llmRules.append(rule)
            except Exception:
                pass
    _diff_queue = []
    _last_flush = time.monotonic()
    total = localRules + llmRules
    try:
        from app.services.brain_event_bus import emitBrainEvent

        if total:
            emitBrainEvent(
                category='delta_engine',
                layer='delta_engine.flush_queue',
                summary=f'Delta engine inferred {len(total)} preference(s) from your edits',
                meta={'local': len(localRules), 'llm': len(llmRules)},
            )
    except Exception:
        pass
    return total


def shouldFlush() -> bool:
    """Check if the diff queue should be flushed."""
    if len(_diff_queue) >= _BATCHFlushCount:
        return True
    if time.monotonic() - _last_flush >= _BATCHFlushSeconds:
        return True
    return False


def _hashPath(filePath: str) -> str:
    """Generate a storage key for a file path."""
    return f'delta_{hashlib.md5(filePath.encode()).hexdigest()}'


def _writeHash(key: str, content: str) -> None:
    """Store a content hash (in memory for now, extend to SQLite if needed)."""
    from app.services.memory_store import save_memory

    save_memory(key, content)


def _readHash(key: str) -> str | None:
    """Read a stored content hash."""
    from app.services.memory_store import get_memory

    val = get_memory(key)
    if isinstance(val, str):
        return val
    return None


def _processDiff(filePath: str, original: str, current: str) -> list[str]:
    """Process a diff between original and current file content."""
    diff = list(
        unifiedDiff(
            original.splitlines(keepends=True),
            current.splitlines(keepends=True),
            fromfile='model_output',
            tofile='user_edit',
        )
    )
    if not diff:
        return []
    _diff_queue.append(
        {'file': filePath, 'original': original, 'edited': current, 'diff': ''.join(diff), 'timestamp': time.time()}
    )
    if shouldFlush():
        return flushQueue()
    return []


def _inferLlmRule(entry: dict) -> str | None:
    """Infer a preference rule from a diff using the Hippocampus model.

    In production this calls the Hippocampus model. For now, returns
    a placeholder.
    """
    try:
        diffText = as_str(entry.get('diff'), '')[:2000]
        return _callHippocampus(diffText)
    except Exception:
        return None


def _callHippocampus(diffText: str) -> str | None:
    """v2: Call the Hippocampus model to infer a rule from a diff.

    Uses the provider client if available; falls back to None when no
    model is configured.
    """
    try:
        from app.services.workbench import model_fleet
        from app.providers import resolver as providerResolver
        from app.providers.clients import getClient

        model = model_fleet.getModelForRole('hippocampus')
        if not model:
            return None
        provider = providerResolver.resolve(model)
        if not provider:
            return None
        client = getClient(provider)
        if client and hasattr(client, 'generate'):
            prompt = f"Review these diffs between the assistant's output and the user's edits. Infer up to 3 behavioral rules. Return JSON: {{'rules': [{{'rule': str, 'category': str}}]}} or {{'rules': []}}.\n\nDiffs:\n{diffText}\n"
            response = client.generate(prompt)
            return response if isinstance(response, str) else None
    except Exception:
        pass
    return None


def subscribeEnvWatcher(watcher) -> None:
    """v2: Subscribe delta engine to environment watcher events."""
    watcher.subscribe(_onEnvChange)


def _onEnvChange(event) -> None:
    """v2: Handle env watcher change — call check_and_diff."""
    if hasattr(event, 'path'):
        try:
            checkAndDiff(event.path)
        except Exception:
            pass
