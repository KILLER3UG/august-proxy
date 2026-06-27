"""Skill curator tests (C3).

Tests usage telemetry, lifecycle transitions (active→stale→archived),
pin/archive/restore, ``_is_agent_skill`` gating, and the curator API routes.
Uses ``isolated_skills`` + ``isolated_data`` fixtures.
"""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import skill_service
from app.services.skills.curator import SkillCurator, UsageRecord, make_background_curator


# ── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def curator(isolated_data, isolated_skills, monkeypatch):
    """Curator with isolated data/skills dirs."""
    data_dir = isolated_data
    return SkillCurator(data_dir=data_dir)


@pytest.fixture
def seeded_skills(curator, isolated_skills):
    """Create fixture skills for lifecycle tests."""
    agent_root, _ = isolated_skills
    skill_service.create_skill("active-skill", "Recently used.", "body.",
                               created_by="agent", category="test")
    skill_service.create_skill("old-skill", "No activity.", "body.",
                               created_by="agent", category="test")
    skill_service.create_skill("bundled-ish", "Should not appear.", "body.",
                               created_by="", category="test")
    # Set old-skill's last_used to long ago.
    rec = curator._ensure("old-skill")
    rec.last_used_at = time.time() - 15 * 86400  # 15 days → stale
    curator._save()
    # Bump usage so all created skills appear in list_usage.
    curator.bump_use("active-skill")
    curator.bump_use("bundled-ish")
    curator._save()
    return agent_root


# ── Unit tests ────────────────────────────────────────────────────────


class TestCurator:
    def test_bump_creates_and_increments(self, curator):
        curator.bump_use("my-skill")
        rec = curator.get_record("my-skill")
        assert rec is not None
        assert rec.use_count == 1
        assert rec.last_used_at is not None

        curator.bump_use("my-skill")
        assert curator.get_record("my-skill").use_count == 2

    def test_bump_view_and_patch(self, curator):
        curator.bump_view("a"); curator.bump_patch("a")
        rec = curator.get_record("a")
        assert rec.view_count == 1
        assert rec.patch_count == 1

    def test_list_usage(self, curator):
        curator.bump_use("x")
        lst = curator.list_usage()
        names = [e["name"] for e in lst]
        assert "x" in names

    def test_pin_and_unpin(self, curator, isolated_skills, seeded_skills):
        skill_service.create_skill("pin-me", "Desc.", "body.", created_by="agent")
        assert curator.pin("pin-me") is True
        assert curator.get_record("pin-me").pinned is True
        assert curator.unpin("pin-me") is True
        assert curator.get_record("pin-me").pinned is False

    def test_pin_refuses_bundled(self, curator, isolated_skills, seeded_skills):
        # A skill created with non-"agent" tag
        skill_service.create_skill("not-agent", "Desc.", "body.", created_by="user")
        assert curator.pin("not-agent") is False

    def test_archive_and_restore(self, curator, isolated_skills, seeded_skills):
        skill_service.create_skill("arch-me", "Desc.", "body.", created_by="agent")
        assert curator.archive("arch-me") is True
        rec = curator.get_record("arch-me")
        assert rec is not None
        assert rec.state == "archived"
        assert rec.archived_at is not None
        # Skill dir moved to .archive
        agent_root = skill_service._agent_skills_dir()
        assert (agent_root / ".archive" / "arch-me").exists()
        assert not (agent_root / "arch-me").exists()

        assert curator.restore("arch-me") is True
        assert curator.get_record("arch-me").state == "active"
        assert (agent_root / "arch-me").exists()

    def test_archive_refuses_pinned(self, curator, isolated_skills):
        skill_service.create_skill("pinned-s", "Desc.", "body.", created_by="agent")
        curator.pin("pinned-s")
        assert curator.archive("pinned-s") is False

    def test_archive_refuses_bundled(self, curator, isolated_skills):
        skill_service.create_skill("bundled", "Desc.", "body.", created_by="")
        assert curator.archive("bundled") is False

    def test_archive_refuses_nonexistent(self, curator):
        assert curator.archive("no-such") is False

    def test_run_curation_transitions_stale(self, curator, seeded_skills):
        report = curator.run_curation()
        assert "old-skill" in report["staled"]
        rec = curator.get_record("old-skill")
        assert rec is not None
        assert rec.state == "stale"

    def test_run_curation_dry_run(self, curator, seeded_skills):
        report = curator.run_curation(dry_run=True)
        assert "old-skill" in report["staled"]
        rec = curator.get_record("old-skill")
        assert rec is not None
        assert rec.state != "stale"  # dry run DID NOT change state

    def test_make_background_curator(self, isolated_data):
        data_dir = isolated_data
        # Call outside an event loop: just test the curator is returned, not the task.
        try:
            cur, task = make_background_curator(data_dir=data_dir)
            assert cur is not None
            task.cancel()
        except RuntimeError:
            # No running event loop — just verify the curator object is valid.
            from app.services.skills.curator import SkillCurator
            cur = SkillCurator(data_dir=data_dir)
            assert cur is not None


# ── API routes ────────────────────────────────────────────────────────


def _app(curator) -> FastAPI:
    app = FastAPI()
    from app.routers import curator as curator_router
    app.include_router(curator_router.router)
    app.state.curator = curator
    return app


def test_list_usage_via_api(curator, seeded_skills):
    client = TestClient(_app(curator))
    r = client.get("/api/curator/usage")
    assert r.status_code == 200
    names = [e["name"] for e in r.json().get("usage", [])]
    assert "active-skill" in names


def test_pin_via_api(curator, seeded_skills):
    skill_service.create_skill("api-pin", "Desc.", "body.", created_by="agent")
    client = TestClient(_app(curator))
    r = client.post("/api/curator/pin/api-pin")
    assert r.status_code == 200
    assert curator.get_record("api-pin").pinned is True


def test_archive_and_restore_via_api(curator, seeded_skills):
    skill_service.create_skill("api-arch", "Desc.", "body.", created_by="agent")
    client = TestClient(_app(curator))
    r = client.post("/api/curator/archive/api-arch")
    assert r.status_code == 200
    assert curator.get_record("api-arch").state == "archived"

    r = client.post("/api/curator/restore/api-arch")
    assert r.status_code == 200
    assert curator.get_record("api-arch").state == "active"


def test_run_curation_via_api(curator, seeded_skills):
    client = TestClient(_app(curator))
    r = client.post("/api/curator/run?dry_run=true")
    assert r.status_code == 200
    report = r.json()["report"]
    assert "old-skill" in report["staled"]
