"""Regression tests: automatic memory self-maintenance loop.

The user never clicks "Review what I remember" — the loop runs on a schedule,
auto-applies safe actions (improve/enhance/merge), and converts removals into
harness proposals for human approval. Deletions must NEVER be automatic.
"""

from __future__ import annotations

import pytest
from app.services.memory import auto_review_loop


@pytest.fixture()
def _kv_store(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', str(tmp_path), raising=False)
    # memory_store KV is backed by the brain sqlite in dataDir; the conftest
    # isolation fixture handles schema init.
    yield


def test_interval_gate_skips_early_rerun(_kv_store):
    import asyncio
    import time

    auto_review_loop._write_state({'lastRunAt': int(time.time())})
    out = asyncio.run(auto_review_loop.run_auto_review())
    assert out['ran'] is False
    assert out['reason'] == 'interval-not-due'


def test_force_bypasses_interval_gate(_kv_store, monkeypatch):
    import asyncio
    import time

    auto_review_loop._write_state({'lastRunAt': time.time()})

    async def fake_review(model_id='', origin='all', folder_id='', session_id=''):
        return {'model': 'test-model', 'improve': [], 'remove': [], 'enhance': [], 'merge': []}

    import app.services.memory.memory_review as mr

    monkeypatch.setattr(mr, 'run_memory_review', fake_review)
    out = asyncio.run(auto_review_loop.run_auto_review(force=True))
    assert out['ran'] is True and out['ok'] is True


def test_removals_become_proposals_never_applied(_kv_store, monkeypatch):
    import asyncio

    applied_actions: list[list] = []

    async def fake_review(model_id='', origin='all', folder_id='', session_id=''):
        return {
            'model': 'test-model',
            'improve': [{'id': 1, 'rewritten': 'better text', 'why': 'clearer'}],
            'remove': [{'id': 42, 'why': 'stale duplicate'}],
            'enhance': [],
            'merge': [],
        }

    def fake_apply(actions):
        applied_actions.append(list(actions))
        return {'improved': 1}

    import app.services.memory.memory_review as mr

    monkeypatch.setattr(mr, 'run_memory_review', fake_review)
    monkeypatch.setattr(mr, 'apply_review_actions', fake_apply)

    out = asyncio.run(auto_review_loop.run_auto_review(force=True))
    assert out['ok'] is True
    # Only the improve row reached the applier — the removal did NOT.
    kinds = [a.get('kind') for a in applied_actions[0]]
    assert kinds == ['improve']
    assert out['skippedRemove'] == 1
    # And the removal became an open proposal for human approval.
    from app.services.harness_self_improve import list_proposals

    props = list_proposals()
    assert any(p.get('status') == 'open' and 'removing a memory' in str(p.get('problem', '')) for p in props)


def test_last_run_summary_formats_quietly(_kv_store):
    import time

    auto_review_loop._write_state({'lastRunAt': int(time.time()) - 3600, 'applied': 3, 'skippedRemove': 1})
    s = auto_review_loop.last_run_summary()
    assert '1h ago' in s and '3 memory improvements applied' in s and '1 removals await' in s
    # Never-run store → empty string (UI hides the line).
    auto_review_loop._write_state({})
    assert auto_review_loop.last_run_summary() == ''
