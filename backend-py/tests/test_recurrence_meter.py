"""Part 16 Phase E — recurrence meter (usage sidecar + resolution math).

Plan acceptance (§3.5/§6): load_skill/load_skills bump the per-skill usage
sidecar; a shipped skill's fingerprint with 0 recurrences in 30 days
becomes resolved; recurrence re-flags + drafts a revision-or-retire
suggestion; zero loads + no recurrence drafts a demotion proposal — all
suggestion-only, never auto-deleted.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from app.services import episode_miner as em
from app.services import skill_service


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


@pytest.fixture()
def agentRoot(monkeypatch, tmp_path):
    root = tmp_path / 'agent-skills'
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: root)
    return root


def _shipSkillProposal(fp: str, name: str) -> None:
    """Simulate an APPLIED distiller skill_create for this fingerprint."""
    from app.services import harness_self_improve as hsi

    row = hsi.save_proposal(
        problem=f'distiller create_skill for {fp}',
        evidence='flagged fingerprint',
        proposal=f'create {name}',
        rollback='delete the skill',
        kind='skill_create',
        payload={'name': name, 'description': 'd', 'body': 'b', 'fingerprint': fp, 'origin': 'distilled'},
    )
    hsi.decide_proposal(row['id'], 'approve')


def _setFingerprint(fp: str, *, lastSeen: datetime, status: str, count: int = 1) -> None:
    from app.services.memory_conn import conn

    conn().execute(
        """
        INSERT INTO failure_fingerprints (fingerprint, episode_count, first_seen, last_seen, status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET last_seen = excluded.last_seen,
            status = excluded.status, episode_count = excluded.episode_count
        """,
        (fp, count, lastSeen.isoformat(), lastSeen.isoformat(), status),
    )
    conn().commit()


class TestUsageSidecar:
    def test_load_skill_bumps_usage(self, agentRoot, isolatedData):
        import asyncio

        from app.services.tool_registrations.skill_tools import _loadSkill

        d = agentRoot / 'used-skill'
        d.mkdir()
        (d / 'SKILL.md').write_text(
            '---\nname: used-skill\ndescription: d\ncategory: learned\n---\n\nBody.\n',
            'utf-8',
        )
        skill_service._bust_prompt_skills_cache()
        out = asyncio.run(_loadSkill('used-skill'))
        assert not out.startswith('Error')
        sidecar = d / '.usage.json'
        data = json.loads(sidecar.read_text('utf-8'))
        assert data['count'] == 1 and data['lastUsed']
        asyncio.run(_loadSkill('used-skill'))
        assert json.loads(sidecar.read_text('utf-8'))['count'] == 2


class TestResolutionMath:
    def test_stale_open_fingerprint_resolves(self, brain, agentRoot):
        _shipSkillProposal('tool-error:resolve-me', 'resolve-skill')
        _setFingerprint(
            'tool-error:resolve-me',
            lastSeen=datetime.now(timezone.utc) - timedelta(days=45),
            status='open',
        )
        out = em.run_resolution_check(windowDays=30)
        assert out['resolved'] >= 1
        row = em.recent_fingerprints(limit=50)
        match = next(r for r in row if r['fingerprint'] == 'tool-error:resolve-me')
        assert match['status'] == 'resolved'

    def test_recurrence_reflags_and_files_revision_suggestion(self, brain, agentRoot):
        from app.services import harness_self_improve as hsi

        _shipSkillProposal('tool-error:recur-me', 'recur-skill')
        # Resolved, but the fingerprint recurred recently.
        _setFingerprint(
            'tool-error:recur-me',
            lastSeen=datetime.now(timezone.utc) - timedelta(days=2),
            status='resolved',
        )
        out = em.run_resolution_check(windowDays=30)
        assert out['recurred'] >= 1
        fpRow = next(
            r for r in em.recent_fingerprints(limit=50) if r['fingerprint'] == 'tool-error:recur-me'
        )
        assert fpRow['status'] == 'open' and fpRow['flagged'] == 1
        suggestions = [
            p for p in hsi.list_proposals(status='open')
            if isinstance(p.get('payload'), dict)
            and p['payload'].get('action') == 'revise_or_retire'
        ]
        assert suggestions, 'revision-or-retire suggestion must be filed'

    def test_zero_loads_files_demotion_suggestion_only(self, brain, agentRoot):
        from app.services import harness_self_improve as hsi

        _shipSkillProposal('tool-error:demote-me', 'demote-skill')
        _setFingerprint(
            'tool-error:demote-me',
            lastSeen=datetime.now(timezone.utc) - timedelta(days=45),
            status='open',
        )
        out = em.run_resolution_check(windowDays=30)
        assert out['demotionSuggestions'] >= 1
        suggestions = [
            p for p in hsi.list_proposals(status='open')
            if isinstance(p.get('payload'), dict) and p['payload'].get('action') == 'demote'
        ]
        assert suggestions and suggestions[0]['kind'] == 'skill_delete'
        # suggestion-only: the skill still exists
        assert (agentRoot / 'demote-skill').exists()

    def test_used_skill_never_gets_demotion_suggestion(self, brain, agentRoot):
        _shipSkillProposal('tool-error:used-fp', 'used-fp-skill')
        _setFingerprint(
            'tool-error:used-fp',
            lastSeen=datetime.now(timezone.utc) - timedelta(days=45),
            status='open',
        )
        d = agentRoot / 'used-fp-skill'
        (d / '.usage.json').write_text(json.dumps({'count': 3, 'lastUsed': 'now'}), 'utf-8')
        out = em.run_resolution_check(windowDays=30)
        assert out['demotionSuggestions'] == 0

    def test_no_fingerprint_no_suggestions(self, brain, agentRoot):
        before = em.run_resolution_check(windowDays=30)
        assert before == {'resolved': 0, 'recurred': 0, 'demotionSuggestions': 0}


class TestCuratorReport:
    def test_report_blob(self, brain):
        import asyncio

        from app.main import app
        from httpx import ASGITransport, AsyncClient

        async def call():
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url='http://t') as ac:
                return await ac.get('/api/curator/report')

        r = asyncio.run(call())
        assert r.status_code == 200
        data = r.json()
        assert data['mode'] in ('off', 'extract-only', 'full')
        assert {'episodes', 'tier2', 'judged', 'fingerprints', 'flaggedFingerprints', 'resolvedFingerprints'} <= set(data['learning'])
        assert 'amendBodyEnabled' in data['precision']
