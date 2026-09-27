"""Audit D8 (2026-09-26): one error-family vocabulary for loop + recorder.

The loop's rules/advice/classifier moved to app/services/error_families.py and
workbench re-exports them; the recorder gained the missing ``process_exit``
class and ``family_for_class`` so ``error_class`` rows join against
``guardrail_classes`` digests.
"""

from __future__ import annotations

import app.services.error_families as ef
from app.services.error_families import (
    ERROR_FAMILIES,
    ERROR_FAMILY_ADVICE,
    ERROR_FAMILY_RULES,
    classify_family,
    family_for_class,
)
from app.services.turn_outcomes import classify_error


def test_loop_vocabulary_is_complete_and_joinable():
    assert len(ERROR_FAMILIES) == 8
    assert set(ERROR_FAMILY_ADVICE) == {f for f, _ in ERROR_FAMILY_RULES}
    assert {f for f, _ in ERROR_FAMILY_RULES} == set(ERROR_FAMILIES)


def test_classify_family_keeps_loop_behavior():
    assert classify_family('Command timed out after 30s') == 'timeout'
    assert classify_family('HTTP 429 Too Many Requests') == 'rate_limit'
    assert classify_family('Error: permission denied: /etc/x') == 'permission'
    assert classify_family('FileNotFoundError: no such file') == 'not_found'
    assert classify_family('all good, 42 tests passed') == ''
    assert classify_family('') == ''


def test_workbench_reexports_are_the_shared_objects():
    from app.services.workbench import workbench as wb

    assert wb._ERROR_FAMILY_RULES is ERROR_FAMILY_RULES
    assert wb._ERROR_FAMILY_ADVICE is ERROR_FAMILY_ADVICE
    assert wb._error_family is classify_family


def test_recorder_gains_process_exit():
    assert classify_error('command failed with exit code 1') == 'process_exit'
    assert classify_error('Traceback (most recent call last):\n  File "x.py"') == 'process_exit'
    # More specific upstream errors still win — process_exit is the last match.
    assert classify_error('connection refused after exit code 1') == 'network'


def test_family_for_class_joins_the_vocabularies():
    # The historical label stays on the row (lesson signatures depend on it)
    # but joins as the loop family.
    assert family_for_class('bad_request') == 'invalid_argument'
    assert family_for_class('timeout') == 'timeout'
    assert family_for_class('rate_limit') == 'rate_limit'
    # Recorder-only classes have no loop family — nothing to join on.
    for label in ('cancelled', 'context_overflow', 'upstream_5xx', 'other'):
        assert family_for_class(label) == ''
    assert family_for_class('') == ''
    assert family_for_class('nonsense') == ''
    # Never invents a family outside the enum.
    assert family_for_class('process_exit') in ERROR_FAMILIES
    assert ef.FAMILY_PROCESS_EXIT in ERROR_FAMILIES
