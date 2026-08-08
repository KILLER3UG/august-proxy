"""Auto-compaction triggers at high (≥80%) or critical (≥90%) pressure."""

from app.services.workbench import workbench


def testShouldCompactAtCriticalPressure():
    """Compaction must trigger when attention_pressure == 'critical'."""
    should = workbench._should_auto_compact(attention_pressure='critical', turns_since_compaction=10)
    assert should is True


def testShouldCompactAtHighPressure():
    """Compaction must trigger at 'high' pressure (≥80% of model context window)."""
    should = workbench._should_auto_compact(attention_pressure='high', turns_since_compaction=10)
    assert should is True


def testShouldNotCompactAtMediumPressure():
    should = workbench._should_auto_compact(attention_pressure='medium', turns_since_compaction=10)
    assert should is False


def testShouldNotCompactWithinCooldown():
    """Suppress re-compaction within the short cooldown window."""
    should = workbench._should_auto_compact(attention_pressure='critical', turns_since_compaction=1)
    assert should is False


def testShouldCompactJustAfterCooldown():
    """At high/critical + turns_since_compaction == 2, compaction should run."""
    should = workbench._should_auto_compact(attention_pressure='critical', turns_since_compaction=2)
    assert should is True
    should_high = workbench._should_auto_compact(attention_pressure='high', turns_since_compaction=2)
    assert should_high is True


def testShouldNotCompactAtLowPressure():
    should = workbench._should_auto_compact(attention_pressure='low', turns_since_compaction=10)
    assert should is False


def testResolveModelContextWindowUsesProviderProfile():
    window = workbench._resolveModelContextWindow(
        'test-model',
        {'modelProfiles': {'test-model': {'contextWindow': 64000}}},
    )
    assert window == 64000


def testResolveModelContextWindowFallsBackTo128k():
    window = workbench._resolveModelContextWindow('unknown-model', None)
    assert window == 128000
