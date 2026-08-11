"""Pending subagent proposals must expire (memory + DB), and proposals for a
deleted session must be expired with it."""

from __future__ import annotations

import asyncio
import time
import types

import pytest
from app.services.memory_store import _conn
from app.services.tools import spawn_subagents_tool as sst


@pytest.fixture(autouse=True)
def _clean_proposals():
    sst._pendingProposals.clear()
    yield
    sst._pendingProposals.clear()


def _make_proposal(session_id: str) -> str:
    session = types.SimpleNamespace(id=session_id, model='m', provider='p', agentId='', subagent_depth=0)
    result = asyncio.run(
        sst.executeSpawnSubagents(None, session, [{'goal': 'g1', 'agentId': 'general'}], mode='proposed')
    )
    assert result.get('status') == 'awaiting_approval'
    return result['proposalId']


def test_proposal_expires_after_ttl():
    """A proposal older than PROPOSAL_TTL_S leaves memory and is marked
    'expired' in the DB."""
    pid = _make_proposal('wb_prop_1')
    assert pid in sst._pendingProposals
    row = _conn().execute(
        "SELECT status FROM proposals WHERE session_id = 'wb_prop_1' AND status = 'pending'"
    ).fetchone()
    assert row is not None, 'proposal should be persisted as pending'

    # Sweep with `now` pushed past the TTL — both the in-memory entry and the
    # persisted row were created just now and must both expire.
    expired = sst._expire_stale_proposals(now=time.time() + sst.PROPOSAL_TTL_S + 1)
    assert expired >= 1
    assert pid not in sst._pendingProposals
    row = _conn().execute(
        "SELECT status FROM proposals WHERE session_id = 'wb_prop_1' AND content LIKE ?",
        (f'%{pid}%',),
    ).fetchone()
    assert row is not None
    assert row['status'] == 'expired'


def test_fresh_proposal_survives_sweep():
    pid = _make_proposal('wb_prop_2')
    sst._expire_stale_proposals()
    assert pid in sst._pendingProposals
    row = _conn().execute(
        "SELECT status FROM proposals WHERE session_id = 'wb_prop_2' AND status = 'pending'"
    ).fetchone()
    assert row is not None


def test_expire_proposals_for_deleted_session():
    pid_a = _make_proposal('wb_prop_a')
    pid_b = _make_proposal('wb_prop_b')

    expired = sst.expire_proposals_for_session('wb_prop_a')
    assert expired >= 1
    assert pid_a not in sst._pendingProposals
    assert pid_b in sst._pendingProposals
    row_a = _conn().execute(
        "SELECT status FROM proposals WHERE session_id = 'wb_prop_a'"
    ).fetchone()
    assert row_a is not None and row_a['status'] == 'expired'
    row_b = _conn().execute(
        "SELECT status FROM proposals WHERE session_id = 'wb_prop_b' AND status = 'pending'"
    ).fetchone()
    assert row_b is not None
