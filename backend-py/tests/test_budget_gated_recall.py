"""Budget-gated auto-recall: headroom decides whether memories are injected."""

from __future__ import annotations

from app.services.workbench import workbench as wb


def test_recall_off_without_budget():
    assert wb._shouldAutoRecall(None) is False


def test_recall_off_under_pressure():
    assert wb._shouldAutoRecall({'attention_pressure': 'high', 'remaining_tokens': 100000}) is False
    assert wb._shouldAutoRecall({'attention_pressure': 'critical', 'remaining_tokens': 100000}) is False


def test_recall_off_with_low_headroom():
    assert wb._shouldAutoRecall({'attention_pressure': 'low', 'remaining_tokens': 5000}) is False
    assert wb._shouldAutoRecall({'attention_pressure': 'medium', 'remaining_tokens': 5999}) is False


def test_recall_on_with_headroom():
    assert wb._shouldAutoRecall({'attention_pressure': 'low', 'remaining_tokens': 9000}) is True
    assert wb._shouldAutoRecall({'attention_pressure': 'medium', 'remaining_tokens': 6000}) is True


def test_recall_custom_min_headroom():
    assert wb._shouldAutoRecall({'attention_pressure': 'low', 'remaining_tokens': 100}, min_headroom=50) is True
    assert wb._shouldAutoRecall({'attention_pressure': 'low', 'remaining_tokens': 40}, min_headroom=50) is False


def test_recall_missing_keys_off():
    assert wb._shouldAutoRecall({}) is False
    assert wb._shouldAutoRecall({'attention_pressure': 'low'}) is False
