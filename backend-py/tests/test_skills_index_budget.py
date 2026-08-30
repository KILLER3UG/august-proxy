"""Part 18 P2.1 — skills-index byte budget for descriptive catalogues.

The unbounded descriptive catalogue (subagent prompts) is a prompt-byte
hazard: every entry is re-sent per subagent launch. Adopt a fixed byte
budget with deterministic stop-packing: alphabetically, stop at the first
entry that would overflow, no silent mid-entry cuts, and surface the
overflow as an explicit notice + log (the issue must be visible, not
silently dropped).
"""

from __future__ import annotations

import logging

import pytest
from app.services import capabilities_prompt as cp


def _entry(name: str, description: str, *, trigger: str = '', category: str = 'gen') -> dict:
    d = {
        'name': name,
        'description': description,
        'category': category,
        'created_by': 'human',
    }
    if trigger:
        d['trigger'] = trigger
    return d


def test_under_budget_renders_unchanged():
    catalogue = [_entry('alpha', 'A small skill'), _entry('beta', 'Another skill')]
    out = cp.format_skills_by_category(catalogue)
    assert 'alpha' in out and 'beta' in out
    assert 'truncated' not in out.lower()
    assert 'omitted' not in out.lower()


def test_overflow_deterministic_stop(caplog):
    """Entries are packed alphabetically and stop BEFORE the first entry
    that would overflow; the notice counts what was cut; two calls produce
    identical bytes."""
    small1 = _entry('aaa', 'first small')
    small2 = _entry('bbb', 'second small')
    big = _entry('zzz', 'z' * 60_000)
    catalogue = [big, small1, small2]
    with caplog.at_level(logging.WARNING, logger=cp.__name__):
        o1 = cp.format_skills_by_category(catalogue)
        o2 = cp.format_skills_by_category(catalogue)
    assert o1 == o2, 'overflow packing must be deterministic'
    assert 'aaa' in o1 and 'bbb' in o1
    assert 'zzz' not in o1, 'the first overflowing entry must be omitted, not cut'
    assert 'truncated' in o1.lower()
    assert '2 of 3' in o1
    assert any('skills index' in r.message for r in caplog.records), 'issue must be surfaced via log'


def test_single_oversized_entry_still_lists_when_alone(caplog):
    """A lone entry larger than the budget is listed whole (no mid-entry
    cut, no empty index) with the overflow surfaced."""
    huge = _entry('only-skill', 'x' * 60_000)
    with caplog.at_level(logging.WARNING, logger=cp.__name__):
        out = cp.format_skills_by_category([huge])
    assert 'only-skill' in out
    assert len(out) >= 60_000
    assert 'truncated' in out.lower() or 'budget' in out.lower()
    assert any('skills index' in r.message for r in caplog.records)


def test_no_mid_entry_cut():
    """Whatever renders, renders WHOLE entries: an omitted entry leaves no
    partial text of its description behind."""
    big = _entry('ccc', 'C' * 50_000)
    small = _entry('aaa', 'small one')
    out = cp.format_skills_by_category([big, small])
    # 'aaa' packs; 'ccc' alone overflows the remaining budget and is aborted
    # WHOLE — no fragment of its 50k-char description may leak.
    assert 'small one' in out
    assert 'ccc' not in out
    assert 'C' * 100 not in out
    assert 'truncated' in out
