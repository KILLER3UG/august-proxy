"""The one error-family vocabulary shared by the turn loop and the recorder.

2026-09-26 audit D8: the loop steered on an eight-family taxonomy while
``turn_outcomes.classify_error`` wrote its own labels (``bad_request`` where
the loop says ``invalid_argument``, ``upstream_5xx`` with no
``process_exit``), so a ``guardrail_classes`` digest could never be joined to
the ``error_class`` of the turns the steering ran in. This module is now the
single owner of the family vocabulary:

* the loop's first-match-wins rules table and nudge advice live here;
  ``workbench`` re-exports them under their historical names, so tests and
  callers reading ``wb._error_family`` keep working unchanged;
* the recorder keeps its own error-class patterns — they are signature-stable
  for lesson promotion (``_signature`` keys facts on the label, and a rename
  would orphan cooldown state) — but gains the missing ``process_exit`` class
  and a :func:`family_for_class` mapping onto this vocabulary. The per-turn
  family list is written to ``turn_outcomes.error_families`` (migration 050),
  which is what makes the guardrail column joinable: both columns now speak
  this enum, and rows predating the mapping simply carry NULL.

Recorder-only classes that have no loop family (``cancelled``,
``context_overflow``, ``upstream_5xx``, ``other``) are listed in
:data:`RECORDER_ONLY_CLASSES` so nothing downstream assumes the two
vocabularies are identical.
"""

from __future__ import annotations

import re

FAMILY_TIMEOUT = 'timeout'
FAMILY_RATE_LIMIT = 'rate_limit'
FAMILY_AUTH = 'auth'
FAMILY_PERMISSION = 'permission'
FAMILY_NOT_FOUND = 'not_found'
FAMILY_NETWORK = 'network'
FAMILY_INVALID_ARGUMENT = 'invalid_argument'
FAMILY_PROCESS_EXIT = 'process_exit'

# The loop's steering vocabulary — deliberately coarse, first-match-wins.
# It steers the nudge; it never decides whether the turn continues.
ERROR_FAMILIES: tuple[str, ...] = (
    FAMILY_TIMEOUT,
    FAMILY_RATE_LIMIT,
    FAMILY_AUTH,
    FAMILY_PERMISSION,
    FAMILY_NOT_FOUND,
    FAMILY_NETWORK,
    FAMILY_INVALID_ARGUMENT,
    FAMILY_PROCESS_EXIT,
)

ERROR_FAMILY_RULES: tuple[tuple[str, str], ...] = (
    (FAMILY_TIMEOUT, r'\btime[d]? ?out\b|deadline exceeded|timed out'),
    (FAMILY_RATE_LIMIT, r'rate[ _-]?limit|\b429\b|too many requests|quota'),
    (FAMILY_AUTH, r'\b401\b|unauthorized|invalid api key|authentication'),
    (FAMILY_PERMISSION, r'\b403\b|permission denied|\beacces\b|not allowed'),
    (FAMILY_NOT_FOUND, r'\b404\b|no such file|not found|cannot find'),
    (FAMILY_NETWORK, r'connection (refused|reset|closed|aborted)|\beconn|getaddrinfo|unreachable'),
    (FAMILY_INVALID_ARGUMENT, r'\b400\b|validation error|invalid (input|argument|json)|required field'),
    (FAMILY_PROCESS_EXIT, r'exit code: [1-9]|exited with code|traceback \(most recent call last\)'),
)

ERROR_FAMILY_ADVICE: dict[str, str] = {
    FAMILY_TIMEOUT: 'run a smaller unit of work, or raise the timeout deliberately',
    FAMILY_RATE_LIMIT: 'stop issuing calls — wait, or answer from what you already have',
    FAMILY_AUTH: 'the credential is wrong or missing; re-asking the same call cannot fix it',
    FAMILY_PERMISSION: 'pick a path/approach the policy allows instead of retrying this one',
    FAMILY_NOT_FOUND: 'verify the path or name exists before relying on it',
    FAMILY_NETWORK: 'the endpoint is unreachable; say so instead of retrying silently',
    FAMILY_INVALID_ARGUMENT: 're-read the tool signature and fix the arguments, not the retry',
    FAMILY_PROCESS_EXIT: 'read the failing output; the same invocation fails the same way',
}

# Recorder error classes that are real turn endings but not tool-error
# families: the user stopped the turn, the context window overflowed, the
# upstream 5xx'd, or nothing matched. classify_error keeps writing them;
# family_for_class maps them to '' so family joins skip them.
RECORDER_ONLY_CLASSES: tuple[str, ...] = (
    'cancelled',
    'context_overflow',
    'upstream_5xx',
    'other',
)

# Recorder class → loop family. ``bad_request`` keeps its historical label on
# the row (lesson signatures depend on it) but joins as invalid_argument.
_FAMILY_BY_CLASS: dict[str, str] = {
    'timeout': FAMILY_TIMEOUT,
    'rate_limit': FAMILY_RATE_LIMIT,
    'auth': FAMILY_AUTH,
    'permission': FAMILY_PERMISSION,
    'not_found': FAMILY_NOT_FOUND,
    'network': FAMILY_NETWORK,
    'bad_request': FAMILY_INVALID_ARGUMENT,
    'invalid_argument': FAMILY_INVALID_ARGUMENT,
    'process_exit': FAMILY_PROCESS_EXIT,
}

# The recorder was missing process_exit entirely — the audit's concrete gap:
# the shell telling you the truth was invisible in the measured record.
_PROCESS_EXIT_RE = re.compile(
    r'exit code: [1-9]|exited with code|nonzero exit|traceback \(most recent call last\)',
    re.IGNORECASE,
)


def classify_family(text: str) -> str:
    """Classify one tool failure into a family, or '' when it is not a failure.

    Moved verbatim from ``workbench._error_family`` — same rules, same
    first-match-wins order, same 4,000-char window.
    """
    if not text:
        return ''
    low = text[:4000].lower()
    for family, pattern in ERROR_FAMILY_RULES:
        if re.search(pattern, low):
            return family
    return ''


def family_for_class(label: str) -> str:
    """Map a recorder error class onto the shared family vocabulary.

    Returns '' for recorder-only classes (nothing to join on) and for unknown
    labels — never invents a family.
    """
    return _FAMILY_BY_CLASS.get((label or '').strip(), '')
