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
    # Care phrasing the diagnosis-only arms missed: "being treated for
    # depression" names neither a drug nor `diagnosed with`, but is the same
    # health fact. The condition words bind to a care verb or a first-person
    # shape so the historical "Great Depression" and a bare "anxiety about
    # the release" stay clean.
    r'(?:being )?treated for|in therapy|therapy for|medicated for|'
    r'(?:i|i\'?m|we(?:\'re)?)\s+(?:\w+\s+){0,2}'
    r'(?:have|had|feel|felt|am|was|struggling with|dealing with)\s+'
    r'(?:depress\w*|anxiety|anxious|bipolar|schizophrenia|ptsd|ocd|adhd)|'
    r'social security|ssn\b|passport|credit card|bank account|routing number|tax id|'
    r'religio\w*|political party|political affiliation|'
    r"(?:son|daughter|child|kid)(?:\'s)? (?:name|age|school|medical)"
    r')\b'
    # A child's health within the same sentence: "my daughter Emma age 9 has
    # asthma" names no keyword from the arm above — the condition rides after
    # the child word, not before it.
    r'|\b(?:son|daughter|child|kid)\b[^.]{0,30}?\b'
    r'(?:asthma|allerg\w*|epilep\w*|autism|diabet\w*|adhd|condition|illness)\b'
    r'|\b\d{3}-\d{2}-\d{4}\b',  # SSN-like pattern
    re.IGNORECASE,
)

# A payment-card number: 13–19 digits in groups of up to 4, separated by
# spaces or dashes, accepted only when the digits pass the Luhn checksum.
# The checksum is what keeps order numbers and ticket ids (rarely Luhn-valid
# at this length) out of the denial; a stored PAN persists into every later
# turn's context, which is exactly what the write door exists to prevent.
_CARD_CANDIDATE_RE = re.compile(r'\b\d(?:[\s-]?\d){12,18}\b')


def _luhn_valid(digits: str) -> bool:
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = ord(ch) - 48
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _cardNumberMatch(blob: str) -> str | None:
    for m in _CARD_CANDIDATE_RE.finditer(blob):
        digits = re.sub(r'\D', '', m.group(0))
        if 13 <= len(digits) <= 19 and _luhn_valid(digits):
            return m.group(0).strip()
    return None


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
    if match:
        return match.group(0)
    return _cardNumberMatch(blob)


def isSensitiveMemory(*texts: str) -> bool:
    """True when any text trips the denylist."""
    return sensitiveMemoryReason(*texts) is not None
