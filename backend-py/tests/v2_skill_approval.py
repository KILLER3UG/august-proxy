"""v2 — Test skill approval flow (move staging to active, reject cleanup)."""
import pytest
from app.services import consolidationDaemon
from app.services.memory_store import init, _conn

@pytest.fixture(autouse=True)
def _initDb():
    init()
    yield

def testApprovalMovesSkillToActiveDir(monkeypatch, tmp_path):
    """Approving a pending skill moves it from staging to active."""
    staging = tmp_path / 'staging'
    staging.mkdir()
    active = tmp_path / 'active'
    active.mkdir()
    monkeypatch.setattr(consolidationDaemon, '_staging_dir', str(staging))
    monkeypatch.setattr(consolidationDaemon, '_active_skills_dir', str(active))
    draft = staging / 'v2-approve-test.md'
    draft.write_text('---\nname: v2-approve-test\n---\nbody')
    conn = _conn()
    conn.execute('INSERT INTO pending_skills (name, draft_path, status) VALUES (?, ?, ?)', ('v2-approve-test', str(draft), 'pending'))
    conn.commit()
    consolidationDaemon.approve_pending_skill('v2-approve-test')
    assert (active / 'v2-approve-test.md').exists()
    assert not draft.exists()
    row = conn.execute("SELECT status FROM pending_skills WHERE name = 'v2-approve-test'").fetchone()
    assert row['status'] == 'approved'
    conn.execute("DELETE FROM pending_skills WHERE name = 'v2-approve-test'")
    conn.commit()
    (active / 'v2-approve-test.md').unlink(missing_ok=True)

def testRejectionDeletesStagingFile(monkeypatch, tmp_path):
    """Rejecting a pending skill cleans up the staging file."""
    staging = tmp_path / 'staging'
    staging.mkdir()
    monkeypatch.setattr(consolidationDaemon, '_staging_dir', str(staging))
    draft = staging / 'v2-reject-test.md'
    draft.write_text('body')
    conn = _conn()
    conn.execute('INSERT INTO pending_skills (name, draft_path, status) VALUES (?, ?, ?)', ('v2-reject-test', str(draft), 'pending'))
    conn.commit()
    consolidationDaemon.reject_pending_skill('v2-reject-test')
    assert not draft.exists()
    row = conn.execute("SELECT status FROM pending_skills WHERE name = 'v2-reject-test'").fetchone()
    assert row['status'] == 'rejected'
    conn.execute("DELETE FROM pending_skills WHERE name = 'v2-reject-test'")
    conn.commit()

def testSkillGenesisRespectsRateLimit(monkeypatch, tmp_path):
    """A second skill in the same day is rejected."""
    staging = tmp_path / 'staging'
    staging.mkdir()
    monkeypatch.setattr(consolidationDaemon, '_staging_dir', str(staging))
    import time
    from app.services.memory_store import _conn
    conn = _conn()
    today = time.strftime('%Y-%m-%d')
    conn.execute('INSERT INTO pending_skills (name, draft_path, created_by, created_at) VALUES (?, ?, ?, ?)', ('v2-rate-existing', str(staging / 'x.md'), 'auto-gen', today))
    conn.commit()

    async def fakeCall(prompt, **kwargs):
        return '{"name": "v2-rate-new", "description": "x", "trigger": "y", "body": "z"}'
    monkeypatch.setattr(consolidationDaemon, '_call_prefrontal', fakeCall)
    monkeypatch.setattr(consolidationDaemon, '_get_session_summary', lambda sid: 'x')
    import asyncio
    result = asyncio.run(consolidationDaemon.draft_skill_for_session('v2-rate-test'))
    assert result is None
    conn.execute("DELETE FROM pending_skills WHERE name = 'v2-rate-existing'")
    conn.commit()