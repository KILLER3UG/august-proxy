"""v2 — Test skill approval flow (move staging to active, reject cleanup)."""
import pytest
from app.services import consolidation_daemon
from app.services.memory_store import init, _conn


@pytest.fixture(autouse=True)
def _init_db():
    init()
    yield


def test_approval_moves_skill_to_active_dir(monkeypatch, tmp_path):
    """Approving a pending skill moves it from staging to active."""
    staging = tmp_path / "staging"
    staging.mkdir()
    active = tmp_path / "active"
    active.mkdir()
    monkeypatch.setattr(consolidation_daemon, "_staging_dir", str(staging))
    monkeypatch.setattr(consolidation_daemon, "_active_skills_dir", str(active))

    draft = staging / "v2-approve-test.md"
    draft.write_text("---\nname: v2-approve-test\n---\nbody")

    conn = _conn()
    conn.execute(
        "INSERT INTO pending_skills (name, draft_path, status) VALUES (?, ?, ?)",
        ("v2-approve-test", str(draft), "pending"),
    )
    conn.commit()

    consolidation_daemon.approve_pending_skill("v2-approve-test")

    assert (active / "v2-approve-test.md").exists()
    assert not draft.exists()
    row = conn.execute(
        "SELECT status FROM pending_skills WHERE name = 'v2-approve-test'"
    ).fetchone()
    assert row["status"] == "approved"

    # Cleanup
    conn.execute("DELETE FROM pending_skills WHERE name = 'v2-approve-test'")
    conn.commit()
    (active / "v2-approve-test.md").unlink(missing_ok=True)


def test_rejection_deletes_staging_file(monkeypatch, tmp_path):
    """Rejecting a pending skill cleans up the staging file."""
    staging = tmp_path / "staging"
    staging.mkdir()
    monkeypatch.setattr(consolidation_daemon, "_staging_dir", str(staging))

    draft = staging / "v2-reject-test.md"
    draft.write_text("body")

    conn = _conn()
    conn.execute(
        "INSERT INTO pending_skills (name, draft_path, status) VALUES (?, ?, ?)",
        ("v2-reject-test", str(draft), "pending"),
    )
    conn.commit()

    consolidation_daemon.reject_pending_skill("v2-reject-test")

    assert not draft.exists()
    row = conn.execute(
        "SELECT status FROM pending_skills WHERE name = 'v2-reject-test'"
    ).fetchone()
    assert row["status"] == "rejected"

    conn.execute("DELETE FROM pending_skills WHERE name = 'v2-reject-test'")
    conn.commit()


def test_skill_genesis_respects_rate_limit(monkeypatch, tmp_path):
    """A second skill in the same day is rejected."""
    staging = tmp_path / "staging"
    staging.mkdir()
    monkeypatch.setattr(consolidation_daemon, "_staging_dir", str(staging))

    # Insert one skill created today
    import time
    from app.services.memory_store import _conn
    conn = _conn()
    today = time.strftime("%Y-%m-%d")
    conn.execute(
        "INSERT INTO pending_skills (name, draft_path, created_by, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("v2-rate-existing", str(staging / "x.md"), "auto-gen", today),
    )
    conn.commit()

    # Now try to draft a new one — should be skipped
    async def fake_call(prompt, **kwargs):
        return '{"name": "v2-rate-new", "description": "x", "trigger": "y", "body": "z"}'
    monkeypatch.setattr(consolidation_daemon, "_call_prefrontal", fake_call)
    monkeypatch.setattr(consolidation_daemon, "_get_session_summary",
                        lambda sid: "x")

    import asyncio
    result = asyncio.run(consolidation_daemon.draft_skill_for_session("v2-rate-test"))
    assert result is None  # rate-limited

    # Cleanup
    conn.execute("DELETE FROM pending_skills WHERE name = 'v2-rate-existing'")
    conn.commit()
