"""Degenerate-output guard: unit tests for the repetition-loop detector."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.lib.degenerate_output import is_degenerate_tail  # noqa: E402

CHANT = 'Write! GO! 3. 2. 1. Emit! '


def test_chant_loop_detected():
    text = 'Here is the plan. ' * 20 + CHANT * 12
    assert is_degenerate_tail(text)


def test_chant_loop_with_whitespace_noise_detected():
    # The unit's only variation is spacing — still degenerate.
    noisy = ''.join(CHANT + '\n' * (i % 3) for i in range(12))
    text = 'Working on it. ' * 30 + noisy
    assert is_degenerate_tail(text)


def test_normal_prose_not_detected():
    text = (
        'The fix touches three files. First, the adapter normalizes the '
        'request body before forwarding it upstream, stripping August-only '
        'keys so stricter gateways do not reject the payload. Second, the '
        'retry loop classifies deterministic 400s and stops retrying them. '
        'Third, the transcript renders the error inline with the first line '
        'of the failure so the user sees what happened without expanding '
        'the tool result drawer.'
    )
    assert not is_degenerate_tail(text)


def test_repeated_short_phrase_not_detected():
    # "Thank you." x8 = unit len 10 — below the 12-char unit floor, and the
    # detector must never fire on polite completion endings.
    text = 'All checks pass now. ' * 20 + 'Thank you. ' * 8
    assert not is_degenerate_tail(text)


def test_short_text_never_detected():
    assert not is_degenerate_tail(CHANT * 6)
    assert not is_degenerate_tail('')


def test_repeated_mid_text_with_healthy_tail_not_detected():
    # The chant appears mid-text but real prose follows — the TAIL is what
    # counts, so a healthy completion continues uninterrupted.
    text = CHANT * 12 + 'Now that the chant check is satisfied, the real answer follows: '
    text += 'the adapter strips August-only keys before every upstream call.'
    assert not is_degenerate_tail(text)


def test_punctuation_only_unit_not_detected():
    # Box-drawing separators repeated forever are not model degeneration.
    text = 'Section one. ' * 25 + '─' * 200
    assert not is_degenerate_tail(text)


def test_repeated_single_word_not_detected():
    # "the" x260 is one unit repeated — BUT the repetition sits mid-text and
    # real prose follows; only the TAIL counts, so a healthy completion that
    # quotes or echoes a repetition continues uninterrupted.
    text = 'the ' * 260 + 'The real answer: the adapter strips August-only keys upstream.'
    assert not is_degenerate_tail(text)


def test_zero_padding_not_detected():
    text = 'hash dump: ' + '0' * 400
    assert not is_degenerate_tail(text)
