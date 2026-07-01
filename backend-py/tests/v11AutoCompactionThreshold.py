"""v1.1 — Test that auto-compaction triggers only at attention_pressure=='critical'."""
from app.services.workbench import workbench

def testShouldCompactAtCriticalPressure():
    """Compaction must trigger when attention_pressure == 'critical'."""
    should = workbench._should_auto_compact(attention_pressure='critical', turns_since_compaction=10)
    assert should is True

def testShouldNotCompactAtHighPressure():
    """Compaction must NOT trigger at 'high' pressure (only 'critical')."""
    should = workbench._should_auto_compact(attention_pressure='high', turns_since_compaction=10)
    assert should is False

def testShouldNotCompactAtMediumPressure():
    should = workbench._should_auto_compact(attention_pressure='medium', turns_since_compaction=10)
    assert should is False

def testShouldNotCompactWithin5TurnCooldown():
    """Even at critical pressure, suppress re-compaction within 5 turns."""
    should = workbench._should_auto_compact(attention_pressure='critical', turns_since_compaction=3)
    assert should is False

def testShouldCompactJustAfterCooldown():
    """At critical + turns_since_compaction == 5, compaction should run."""
    should = workbench._should_auto_compact(attention_pressure='critical', turns_since_compaction=5)
    assert should is True

def testShouldNotCompactAtLowPressure():
    should = workbench._should_auto_compact(attention_pressure='low', turns_since_compaction=10)
    assert should is False