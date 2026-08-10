"""Token budget math — monotonicity, invariants, and threshold selection.

The budget bands drive auto-compact and auto-recall; wrong math silently
degrades long sessions, so the pure functions get direct coverage.
"""

from __future__ import annotations

from app.services.workbench.token_budget import (
    computeBudget,
    estimateTokens,
    getCriticalThreshold,
)


def test_estimate_tokens_empty():
    assert estimateTokens('') == 0
    assert estimateTokens(None) == 0


def test_estimate_tokens_monotone_in_length():
    short = estimateTokens('hello world')
    long = estimateTokens('hello world ' * 200)
    assert long > short
    # Same text twice ≈ twice the tokens (within tokenizer drift).
    twice = estimateTokens(('hello world ' * 100) * 2)
    once = estimateTokens('hello world ' * 100)
    assert twice >= once
    assert twice <= once * 2 + 4


def test_estimate_tokens_model_paths_all_nonzero():
    # All four tokenizer paths must return sane non-zero counts.
    for kwargs in (
        {'provider': 'anthropic'},
        {'api_mode': 'anthropicMessages'},
        {'model': 'gpt-4o'},
        {'model': 'gemini-1.5-pro'},
        {},
    ):
        assert estimateTokens('some text here', **kwargs) > 0, kwargs


def test_critical_threshold_selection():
    # Accurate tokenizers get the 90% threshold; the heuristic fallback 85%.
    assert getCriticalThreshold(provider='anthropic') == 0.9
    assert getCriticalThreshold(api_mode='anthropicMessages') == 0.9
    assert getCriticalThreshold(model='gpt-4o') == 0.9
    assert getCriticalThreshold() == 0.85
    assert getCriticalThreshold(model='unknown-model-x') == 0.85


def test_compute_budget_invariants():
    budget = computeBudget('a short message', maxContext=100000)
    assert 0 <= budget['context_used_pct'] <= 100
    assert budget['remaining_tokens'] == 100000 - budget['total_tokens']
    assert budget['max_context'] == 100000
    assert budget['attention_pressure'] in ('low', 'medium', 'high', 'critical')
    assert budget['total_tokens'] == estimateTokens('a short message')
    # Pressure must be low for a tiny message.
    assert budget['attention_pressure'] == 'low'


def test_compute_budget_critical_when_full():
    big = 'x' * 400_000  # ~114k heuristic tokens > 90% of 100k
    budget = computeBudget(big, maxContext=100_000)
    assert budget['remaining_tokens'] == 0
    assert budget['attention_pressure'] == 'critical'


def test_compute_budget_messages_list():
    messages = [
        {'role': 'user', 'content': 'hello'},
        {'role': 'assistant', 'content': 'hi there'},
    ]
    budget = computeBudget(messages)
    assert budget['total_tokens'] > 0
    # pct is the rounded ratio of total over max_context.
    expected_pct = round(budget['total_tokens'] / budget['max_context'] * 100, 1)
    assert budget['context_used_pct'] == expected_pct
