"""v1.1 — Test that auto-compaction triggers only at attention_pressure=='critical'."""
from app.services.workbench import workbench


def test_should_compact_at_critical_pressure():
    """Compaction must trigger when attention_pressure == 'critical'."""
    should = workbench._should_auto_compact(
        attention_pressure="critical",
        turns_since_compaction=10,  # well past the 5-turn cooldown
    )
    assert should is True


def test_should_not_compact_at_high_pressure():
    """Compaction must NOT trigger at 'high' pressure (only 'critical')."""
    should = workbench._should_auto_compact(
        attention_pressure="high",
        turns_since_compaction=10,
    )
    assert should is False


def test_should_not_compact_at_medium_pressure():
    should = workbench._should_auto_compact(
        attention_pressure="medium",
        turns_since_compaction=10,
    )
    assert should is False


def test_should_not_compact_within_5_turn_cooldown():
    """Even at critical pressure, suppress re-compaction within 5 turns."""
    should = workbench._should_auto_compact(
        attention_pressure="critical",
        turns_since_compaction=3,  # within 5-turn cooldown
    )
    assert should is False


def test_should_compact_just_after_cooldown():
    """At critical + turns_since_compaction == 5, compaction should run."""
    should = workbench._should_auto_compact(
        attention_pressure="critical",
        turns_since_compaction=5,
    )
    assert should is True


def test_should_not_compact_at_low_pressure():
    should = workbench._should_auto_compact(
        attention_pressure="low",
        turns_since_compaction=10,
    )
    assert should is False
