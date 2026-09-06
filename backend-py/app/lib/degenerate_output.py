"""Degenerate-output guard: detect a completion stuck in a repetition loop.

Sampling degeneration shows up as the same short unit repeating endlessly
("Write! GO! 3. 2. 1. Emit! Write! GO! …"). Left alone it burns the token
budget, floods the transcript, and can write the chant into workspace files
through the tool loop. The check is byte-cheap: it normalizes the tail of the
accumulated text and fires when one unit repeats back-to-back more times than
legitimate prose ever does.

Thresholds are deliberately conservative — a repeated chorus inside a poem or
a short string echo must NOT abort a healthy completion. A unit only counts
when it is ≥12 normalized chars and repeats ≥6 times CONSECUTIVELY at the very
end of the text, and the text must be non-trivial (≥300 chars) before the
guard is consulted at all.
"""

from __future__ import annotations

import re

_WS = re.compile(r'\s+')
_UNIT_RANGE = range(12, 65)  # candidate repetition periods (normalized chars)
_MIN_REPEATS = 6
_MIN_TEXT_CHARS = 300
_TAIL_WINDOW = 1024

DEGENERATE_OUTPUT_ERROR = (
    '[degenerate output] the model fell into a repetition loop — completion '
    'aborted before it burned the token budget. Retry the request; if it '
    'recurs, lower the temperature or switch models.'
)


def is_degenerate_tail(text: str) -> bool:
    """True when the normalized tail of ``text`` is one unit repeated ≥6×.

    The tail is whitespace-normalized first, so a unit whose only variation
    is spacing still counts. Detection tries every candidate period in
    ``_UNIT_RANGE`` and steps BACKWARD from the text end by exactly that
    period — stepping by the period itself is rotation-invariant, so it
    works no matter where the repetition phase falls. A unit must carry at
    least three alphabetic characters — digits-only padding (zero runs) and
    punctuation/box-drawing separators are not model degeneration.
    """
    if not text or len(text) < _MIN_TEXT_CHARS:
        return False
    norm = _WS.sub(' ', text[-_TAIL_WINDOW:]).strip()
    total = len(norm)
    for period in _UNIT_RANGE:
        span = period * _MIN_REPEATS
        if total < span:
            continue
        unit = norm[total - period:]
        if sum(ch.isalpha() for ch in unit) < 3:
            continue
        if all(
            norm[total - period * i:total - period * (i - 1)] == unit
            for i in range(2, _MIN_REPEATS + 1)
        ):
            return True
    return False
