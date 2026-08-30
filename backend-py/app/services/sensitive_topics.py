"""Sensitive-topic denylist — the shared scanner (Part 16 Phase C).

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
    r'diagnos\w*|cancer|tumor|hiv\b|diabet\w*|medication|prescription|dosage|'
    r'antidepressant|psychotherap\w*|mental illness|'
    r'social security|ssn\b|passport|credit card|bank account|routing number|tax id|'
    r'religio\w*|political party|political affiliation|'
    r"(?:son|daughter|child|kid)(?:\'s)? (?:name|age|school|medical)"
    r')\b'
    r'|\b\d{3}-\d{2}-\d{4}\b',  # SSN-like pattern
    re.IGNORECASE,
)


def isSensitiveMemory(*texts: str) -> bool:
    """True when any text trips the denylist."""
    blob = ' '.join(str(t) for t in texts if t)
    return bool(_SENSITIVE_MEMORY_RE.search(blob))
