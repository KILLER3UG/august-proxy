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
import json
import logging
import os
import time
from difflib import unified_diff
from pathlib import Path
from typing import Any

from app.services.heuristics_service import add_heuristic

logger = logging.getLogger(__name__)

# ── Configuration ───────────────────────────────────────────────────────

_TRACK_WINDOW_SECONDS = 86400   # 24 hours
_BATCH_FLUSH_COUNT = 20          # Flush queue at this many entries
_BATCH_FLUSH_SECONDS = 86400    # Or after this much time

_consent_granted: bool = False
_diff_queue: list[dict[str, Any]] = []
_last_flush: float = time.monotonic()


# ── Consent ─────────────────────────────────────────────────────────────


def is_consent_granted() -> bool:
    """Check if the user has opted into delta engine inference."""
    return _consent_granted


def grant_consent() -> None:
    """Grant consent (called from the first-run dialog handler)."""
    global _consent_granted
    _consent_granted = True
    logger.info("Delta engine consent granted")


def revoke_consent() -> None:
    """Revoke consent."""
    global _consent_granted
    _consent_granted = False
    logger.info("Delta engine consent revoked")


# ── Local-only heuristic patterns ──────────────────────────────────────

_LOCAL_PATTERNS = {
    "tabs": lambda a, b: _detect_tabs(a, b),
    "spaces": lambda a, b: _detect_spaces(a, b),
    "single_quotes": lambda a, b: _detect_quotes(a, b, "'"),
    "double_quotes": lambda a, b: _detect_quotes(a, b, '"'),
    "trailing_semicolons": lambda a, b: _detect_trailing(a, b, ";"),
    "trailing_commas": lambda a, b: _detect_trailing(a, b, ","),
}


def _detect_tabs(original: str, edited: str) -> str | None:
    """Detect tab preference changes."""
    orig_tabs = original.count("\t")
    edit_tabs = edited.count("\t")
    if orig_tabs < 1 and edit_tabs > orig_tabs:
        return "Use tabs for indentation"
    if orig_tabs > 0 and edit_tabs < orig_tabs:
        return "Use spaces for indentation"
    return None


def _detect_spaces(original: str, edited: str) -> str | None:
    """Detect space-count preference."""
    orig_spaces = len(original) - len(original.replace("  ", " "))
    edit_spaces = len(edited) - len(edited.replace("  ", " "))
    if edit_spaces > orig_spaces:
        return "Use more spaces for formatting"
    return None


def _detect_quotes(original: str, edited: str, quote: str) -> str | None:
    """Detect single/double quote preference."""
    orig_count = original.count(quote)
    edit_count = edited.count(quote)
    if edit_count > orig_count:
        other = '"' if quote == "'" else "'"
        return f"Use {quote}quotes instead of {other}quotes"
    return None


def _detect_trailing(original: str, edited: str, char: str) -> str | None:
    """Detect trailing punctuation preference."""
    def _count_trailing(text: str, c: str) -> int:
        return sum(1 for line in text.split("\n") if line.strip().endswith(c))
    orig_c = _count_trailing(original, char)
    edit_c = _count_trailing(edited, char)
    if edit_c > orig_c:
        return f"Add trailing {char}"
    if orig_c > 0 and edit_c < orig_c:
        return f"Remove trailing {char}"
    return None


# ── Core API ────────────────────────────────────────────────────────────


def track_write(file_path: str, content: str) -> None:
    """Track a write_file call by the model.

    Stores a content hash for later comparison.
    """
    hash_path = _hash_path(file_path)
    _write_hash(hash_path, content)


def check_and_diff(file_path: str) -> list[str]:
    """Check if a file was changed externally and record diffs.

    Returns list of inferred preference rules (may be empty).
    """
    if not os.path.exists(file_path):
        return []

    hash_path = _hash_path(file_path)
    original_content = _read_hash(hash_path)
    if original_content is None:
        return []  # Not a tracked file

    with open(file_path) as f:
        current_content = f.read()

    if current_content == original_content:
        return []  # No change

    inferred = _process_diff(file_path, original_content, current_content)
    return inferred


def flush_queue() -> list[str]:
    """Flush the diff queue and process batched diffs.

    Returns any newly inferred rules.
    """
    global _diff_queue, _last_flush
    if not _diff_queue:
        return []

    # Process local-only patterns (no LLM needed)
    local_rules: list[str] = []
    for entry in _diff_queue:
        for pattern_name, detector in _LOCAL_PATTERNS.items():
            try:
                rule = detector(entry.get("original", ""), entry.get("edited", ""))
                if rule:
                    add_heuristic(rule, source="local-diff", category="coding_style")
                    local_rules.append(rule)
            except Exception:
                pass

    # LLM path (only with consent)
    llm_rules: list[str] = []
    if is_consent_granted():
        for entry in _diff_queue:
            try:
                rule = _infer_llm_rule(entry)
                if rule:
                    add_heuristic(rule, source="delta-engine", category="coding_style")
                    llm_rules.append(rule)
            except Exception:
                pass

    _diff_queue = []
    _last_flush = time.monotonic()
    return local_rules + llm_rules


def should_flush() -> bool:
    """Check if the diff queue should be flushed."""
    if len(_diff_queue) >= _BATCH_FLUSH_COUNT:
        return True
    if time.monotonic() - _last_flush >= _BATCH_FLUSH_SECONDS:
        return True
    return False


# ── Internal ────────────────────────────────────────────────────────────


def _hash_path(file_path: str) -> str:
    """Generate a storage key for a file path."""
    return f"delta_{hashlib.md5(file_path.encode()).hexdigest()}"


def _write_hash(key: str, content: str) -> None:
    """Store a content hash (in memory for now, extend to SQLite if needed)."""
    from app.services.memory_store import save_memory
    save_memory(key, content)


def _read_hash(key: str) -> str | None:
    """Read a stored content hash."""
    from app.services.memory_store import get_memory
    val = get_memory(key)
    if isinstance(val, str):
        return val
    return None


def _process_diff(file_path: str, original: str, current: str) -> list[str]:
    """Process a diff between original and current file content."""
    diff = list(unified_diff(
        original.splitlines(keepends=True),
        current.splitlines(keepends=True),
        fromfile="model_output",
        tofile="user_edit",
    ))

    if not diff:
        return []

    # Queue for batch processing
    _diff_queue.append({
        "file": file_path,
        "original": original,
        "edited": current,
        "diff": "".join(diff),
        "timestamp": time.time(),
    })

    # Flush if queue is full
    if should_flush():
        return flush_queue()

    return []


def _infer_llm_rule(entry: dict) -> str | None:
    """Infer a preference rule from a diff using the Hippocampus model.

    In production this calls the Hippocampus model. For now, returns
    a placeholder.
    """
    try:
        diff_text = entry.get("diff", "")[:2000]
        return _call_hippocampus(diff_text)
    except Exception:
        return None


def _call_hippocampus(diff_text: str) -> str | None:
    """Call the Hippocampus model to infer a rule from a diff."""
    # Placeholder — in production this calls get_model_for_role("hippocampus")
    return None
