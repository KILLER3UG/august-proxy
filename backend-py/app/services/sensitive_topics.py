"""Sensitive-topic denylist — the shared scanner.

Extracted from session_tools.py so every memory-write and draft path
(``remember``, the distiller's judge-drafted summaries/bodies) enforces the
SAME conservative gate. Keyword/regex scan: a hit refuses the write unless
the user turned on ``memorySensitiveTopics``. Covers health specifics, ID
numbers, minors, beliefs.
"""

from __future__ import annotations

import re

_SENSITIVE_MEMORY_RE = re.compile(
    r'\b('
    # `diagnos\w*` on its own was the false positive: it refused an ordinary
    # engineering audit twice because the prose contained "diagnose_proxy" and
    # "self-diagnosis". Diagnosis is routine technical vocabulary, so only the
    # health-shaped forms count now.
    r'diagnosed\s+with|(?:medical|clinical|health)\s+diagnos\w*|'
    r'cancer|tumor|hiv\b|diabet\w*|medication|prescription|dosage|'
    r'antidepressant|psychotherap\w*|mental illness|'
    r'social security|ssn\b|passport|credit card|bank account|routing number|tax id|'
    r'religio\w*|political party|political affiliation|'
    r"(?:son|daughter|child|kid)(?:\'s)? (?:name|age|school|medical)"
    r')\b'
    r'|\b\d{3}-\d{2}-\d{4}\b',  # SSN-like pattern
    re.IGNORECASE,
)


def sensitiveMemoryReason(*texts: str) -> str | None:
    """The matched phrase that tripped the denylist, or None when clean.

    The refusal used to be a bare "this looks like a sensitive topic", which
    left the model unable to tell a genuine health fact from a technical
    false positive — it could only retry and be refused again (audit finding
    2026-09-15 #9). Naming the trigger makes the gate debuggable from the tool
    result alone.
    """
    blob = ' '.join(str(t) for t in texts if t)
    match = _SENSITIVE_MEMORY_RE.search(blob)
    return match.group(0) if match else None


def isSensitiveMemory(*texts: str) -> bool:
    """True when any text trips the denylist."""
    return sensitiveMemoryReason(*texts) is not None
