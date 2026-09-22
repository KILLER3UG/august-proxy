"""One authority for the compaction threshold and the fallback window.

Both were duplicated: `workbench.AUTO_COMPACT_RATIO` and
`context_compressor.COMPACT_TRIGGER_RATIO` held the same 0.80 independently, so
tuning the real trigger left the pressure *label* ("high"/"critical") deciding
on the stale number — the two could disagree silently forever. `128000` was
literal in three fallback sites. These tests fail if a second copy reappears.
"""

from __future__ import annotations

from pathlib import Path

from app.services.workbench import context_compressor, workbench

_WORKBENCH_SRC = Path(workbench.__file__).read_text(encoding='utf-8', errors='replace')


def test_compressor_owns_the_trigger_ratio() -> None:
    assert context_compressor.COMPACT_TRIGGER_RATIO == 0.80


def test_workbench_no_longer_redefines_the_ratio() -> None:
    assert 'AUTO_COMPACT_RATIO' not in _WORKBENCH_SRC, (
        'a second copy of the compact ratio reappeared; import '
        'context_compressor.COMPACT_TRIGGER_RATIO instead'
    )


def test_workbench_reads_the_threshold_it_labels_pressure_with() -> None:
    """The label and the trigger must come from the same symbol."""
    assert 'elif ratio >= COMPACT_TRIGGER_RATIO:' in _WORKBENCH_SRC


def test_fallback_window_is_not_hardcoded_a_second_time() -> None:
    # Once for the definition, nowhere else.
    assert _WORKBENCH_SRC.count('128000') == 1
    assert workbench.DEFAULT_CONTEXT_WINDOW == 128000


def test_legacy_token_budget_is_gone() -> None:
    """A 2,000,000-token constant that nothing read invited "the budget is
    2M" reasoning into a file that keys off the model window instead."""
    assert 'WORKBENCH_TOKEN_BUDGET' not in _WORKBENCH_SRC
