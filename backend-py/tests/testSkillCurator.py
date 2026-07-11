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
from app.services.skills.curator import SkillCurator, UsageRecord, makeBackgroundCurator

@pytest.fixture
def curator(isolatedData, isolatedSkills, monkeypatch):
    """Curator with isolated data/skills dirs."""
    dataDir = isolatedData
    return SkillCurator(dataDir=dataDir)

@pytest.fixture
def seededSkills(curator, isolatedSkills):
    """Create fixture skills for lifecycle tests."""
    agentRoot, __ = isolatedSkills
    skill_service.createSkill('active-skill', 'Recently used.', 'body.', createdBy='agent', category='test')
    skill_service.createSkill('old-skill', 'No activity.', 'body.', createdBy='agent', category='test')
    skill_service.createSkill('bundled-ish', 'Should not appear.', 'body.', createdBy='', category='test')
    rec = curator._ensure('old-skill')
    rec.lastUsedAt = time.time() - 15 * 86400
    curator._save()
    curator.bumpUse('active-skill')
    curator.bumpUse('bundled-ish')
    curator._save()
    return agentRoot

class TestCurator:

    def testBumpCreatesAndIncrements(self, curator):
        curator.bumpUse('my-skill')
        rec = curator.getRecord('my-skill')
        assert rec is not None
        assert rec.useCount == 1
        assert rec.lastUsedAt is not None
        curator.bumpUse('my-skill')
        assert curator.getRecord('my-skill').useCount == 2

    def testBumpViewAndPatch(self, curator):
        curator.bumpView('a')
        curator.bumpPatch('a')
        rec = curator.getRecord('a')
        assert rec.viewCount == 1
        assert rec.patchCount == 1

    def testListUsage(self, curator):
        curator.bumpUse('x')
        lst = curator.listUsage()
        names = [e['name'] for e in lst]
        assert 'x' in names

    def testPinAndUnpin(self, curator, isolatedSkills, seededSkills):
        skill_service.createSkill('pin-me', 'Desc.', 'body.', createdBy='agent')
        assert curator.pin('pin-me') is True
        assert curator.getRecord('pin-me').pinned is True
        assert curator.unpin('pin-me') is True
        assert curator.getRecord('pin-me').pinned is False

    def testPinRefusesBundled(self, curator, isolatedSkills, seededSkills):
        skill_service.createSkill('not-agent', 'Desc.', 'body.', createdBy='user')
        assert curator.pin('not-agent') is False

    def testArchiveAndRestore(self, curator, isolatedSkills, seededSkills):
        skill_service.createSkill('arch-me', 'Desc.', 'body.', createdBy='agent')
        assert curator.archive('arch-me') is True
        rec = curator.getRecord('arch-me')
        assert rec is not None
        assert rec.state == 'archived'
        assert rec.archivedAt is not None
        agentRoot = skill_service._agentSkillsDir()
        assert (agentRoot / '.archive' / 'arch-me').exists()
        assert not (agentRoot / 'arch-me').exists()
        assert curator.restore('arch-me') is True
        assert curator.getRecord('arch-me').state == 'active'
        assert (agentRoot / 'arch-me').exists()

    def testArchiveRefusesPinned(self, curator, isolatedSkills):
        skill_service.createSkill('pinned-s', 'Desc.', 'body.', createdBy='agent')
        curator.pin('pinned-s')
        assert curator.archive('pinned-s') is False

    def testArchiveRefusesBundled(self, curator, isolatedSkills):
        skill_service.createSkill('bundled', 'Desc.', 'body.', createdBy='')
        assert curator.archive('bundled') is False

    def testArchiveRefusesNonexistent(self, curator):
        assert curator.archive('no-such') is False

    def testRunCurationTransitionsStale(self, curator, seededSkills):
        report = curator.runCuration()
        assert 'old-skill' in report['staled']
        rec = curator.getRecord('old-skill')
        assert rec is not None
        assert rec.state == 'stale'

    def testRunCurationDryRun(self, curator, seededSkills):
        report = curator.runCuration(dryRun=True)
        assert 'old-skill' in report['staled']
        rec = curator.getRecord('old-skill')
        assert rec is not None
        assert rec.state != 'stale'

    def testMakeBackgroundCurator(self, isolatedData):
        dataDir = isolatedData
        try:
            cur, task = makeBackgroundCurator(dataDir=dataDir)
            assert cur is not None
            task.cancel()
        except RuntimeError:
            from app.services.skills.curator import SkillCurator
            cur = SkillCurator(dataDir=dataDir)
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
    skill_service.createSkill('api-pin', 'Desc.', 'body.', createdBy='agent')
    client = TestClient(_app(curator))
    r = client.post('/api/curator/pin/api-pin')
    assert r.status_code == 200
    assert curator.getRecord('api-pin').pinned is True

def testArchiveAndRestoreViaApi(curator, seededSkills):
    skill_service.createSkill('api-arch', 'Desc.', 'body.', createdBy='agent')
    client = TestClient(_app(curator))
    r = client.post('/api/curator/archive/api-arch')
    assert r.status_code == 200
    assert curator.getRecord('api-arch').state == 'archived'
    r = client.post('/api/curator/restore/api-arch')
    assert r.status_code == 200
    assert curator.getRecord('api-arch').state == 'active'

def testRunCurationViaApi(curator, seededSkills):
    client = TestClient(_app(curator))
    r = client.post('/api/curator/run?dryRun=true')
    assert r.status_code == 200
    report = r.json()['report']
    assert 'old-skill' in report['staled']