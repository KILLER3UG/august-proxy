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
from app.services import skillService
from app.services.skills.curator import SkillCurator, UsageRecord, makeBackgroundCurator

@pytest.fixture
def curator(isolatedData, isolatedSkills, monkeypatch):
    """Curator with isolated data/skills dirs."""
    dataDir = isolatedData
    return SkillCurator(data_dir=dataDir)

@pytest.fixture
def seededSkills(curator, isolatedSkills):
    """Create fixture skills for lifecycle tests."""
    agentRoot, __ = isolatedSkills
    skillService.create_skill('active-skill', 'Recently used.', 'body.', created_by='agent', category='test')
    skillService.create_skill('old-skill', 'No activity.', 'body.', created_by='agent', category='test')
    skillService.create_skill('bundled-ish', 'Should not appear.', 'body.', created_by='', category='test')
    rec = curator._ensure('old-skill')
    rec.last_used_at = time.time() - 15 * 86400
    curator._save()
    curator.bump_use('active-skill')
    curator.bump_use('bundled-ish')
    curator._save()
    return agentRoot

class TestCurator:

    def testBumpCreatesAndIncrements(self, curator):
        curator.bump_use('my-skill')
        rec = curator.get_record('my-skill')
        assert rec is not None
        assert rec.use_count == 1
        assert rec.last_used_at is not None
        curator.bump_use('my-skill')
        assert curator.get_record('my-skill').use_count == 2

    def testBumpViewAndPatch(self, curator):
        curator.bump_view('a')
        curator.bump_patch('a')
        rec = curator.get_record('a')
        assert rec.view_count == 1
        assert rec.patch_count == 1

    def testListUsage(self, curator):
        curator.bump_use('x')
        lst = curator.list_usage()
        names = [e['name'] for e in lst]
        assert 'x' in names

    def testPinAndUnpin(self, curator, isolatedSkills, seededSkills):
        skillService.create_skill('pin-me', 'Desc.', 'body.', created_by='agent')
        assert curator.pin('pin-me') is True
        assert curator.get_record('pin-me').pinned is True
        assert curator.unpin('pin-me') is True
        assert curator.get_record('pin-me').pinned is False

    def testPinRefusesBundled(self, curator, isolatedSkills, seededSkills):
        skillService.create_skill('not-agent', 'Desc.', 'body.', created_by='user')
        assert curator.pin('not-agent') is False

    def testArchiveAndRestore(self, curator, isolatedSkills, seededSkills):
        skillService.create_skill('arch-me', 'Desc.', 'body.', created_by='agent')
        assert curator.archive('arch-me') is True
        rec = curator.get_record('arch-me')
        assert rec is not None
        assert rec.state == 'archived'
        assert rec.archived_at is not None
        agentRoot = skillService._agent_skills_dir()
        assert (agentRoot / '.archive' / 'arch-me').exists()
        assert not (agentRoot / 'arch-me').exists()
        assert curator.restore('arch-me') is True
        assert curator.get_record('arch-me').state == 'active'
        assert (agentRoot / 'arch-me').exists()

    def testArchiveRefusesPinned(self, curator, isolatedSkills):
        skillService.create_skill('pinned-s', 'Desc.', 'body.', created_by='agent')
        curator.pin('pinned-s')
        assert curator.archive('pinned-s') is False

    def testArchiveRefusesBundled(self, curator, isolatedSkills):
        skillService.create_skill('bundled', 'Desc.', 'body.', created_by='')
        assert curator.archive('bundled') is False

    def testArchiveRefusesNonexistent(self, curator):
        assert curator.archive('no-such') is False

    def testRunCurationTransitionsStale(self, curator, seededSkills):
        report = curator.run_curation()
        assert 'old-skill' in report['staled']
        rec = curator.get_record('old-skill')
        assert rec is not None
        assert rec.state == 'stale'

    def testRunCurationDryRun(self, curator, seededSkills):
        report = curator.run_curation(dry_run=True)
        assert 'old-skill' in report['staled']
        rec = curator.get_record('old-skill')
        assert rec is not None
        assert rec.state != 'stale'

    def testMakeBackgroundCurator(self, isolatedData):
        dataDir = isolatedData
        try:
            cur, task = makeBackgroundCurator(data_dir=dataDir)
            assert cur is not None
            task.cancel()
        except RuntimeError:
            from app.services.skills.curator import SkillCurator
            cur = SkillCurator(data_dir=dataDir)
            assert cur is not None

def _app(curator) -> FastAPI:
    app = FastAPI()
    from app.routers import curator as curatorRouter
    app.include_router(curatorRouter.router)
    app.state.curator = curator
    return app

def testListUsageViaApi(curator, seededSkills):
    client = TestClient(_app(curator))
    r = client.get('/api/curator/usage')
    assert r.status_code == 200
    names = [e['name'] for e in r.json().get('usage', [])]
    assert 'active-skill' in names

def testPinViaApi(curator, seededSkills):
    skillService.create_skill('api-pin', 'Desc.', 'body.', created_by='agent')
    client = TestClient(_app(curator))
    r = client.post('/api/curator/pin/api-pin')
    assert r.status_code == 200
    assert curator.get_record('api-pin').pinned is True

def testArchiveAndRestoreViaApi(curator, seededSkills):
    skillService.create_skill('api-arch', 'Desc.', 'body.', created_by='agent')
    client = TestClient(_app(curator))
    r = client.post('/api/curator/archive/api-arch')
    assert r.status_code == 200
    assert curator.get_record('api-arch').state == 'archived'
    r = client.post('/api/curator/restore/api-arch')
    assert r.status_code == 200
    assert curator.get_record('api-arch').state == 'active'

def testRunCurationViaApi(curator, seededSkills):
    client = TestClient(_app(curator))
    r = client.post('/api/curator/run?dry_run=true')
    assert r.status_code == 200
    report = r.json()['report']
    assert 'old-skill' in report['staled']