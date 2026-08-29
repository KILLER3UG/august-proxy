"""Part 17 Phase E tests — cross-project review & promotion (gated).

The plan's acceptance scenario, end to end:
  two projects sharing a lesson → promotion proposal (≥2-project bar)
  → human approve → global item with promoted-from provenance
  → simulate non-trigger → demote suggestion in the same queue.

Plus the gates: skillLearning off skips the pass; single-project lessons
never propose; the sensitive denylist blocks drafts; rejected drafts are
never re-filed (anti-drift); approval never mutates the project file.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from app.services import memory_store


@pytest.fixture(autouse=True)
def _iso_skills(tmp_path, monkeypatch):
    """Isolate skill roots + proposals dir away from the user's real dirs."""
    from app.services import skill_service

    agentRoot = tmp_path / 'agent-skills'
    agentRoot.mkdir()
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agentRoot)
    skill_service._flat_migrate_done = True
    yield
    skill_service._flat_migrate_done = False


def _mk_workspace(base: Path, name: str) -> str:
    ws = base / name
    (ws / '.aug' / 'memory').mkdir(parents=True, exist_ok=True)
    return str(ws)


def _seed_sessions(workspaces: list[str]) -> None:
    """Register workspaces as KNOWN projects (the enumeration rule: only
    paths bound to a session are ever read by the judge)."""
    from app.services.memory_conn import conn as _conn

    for i, ws in enumerate(workspaces):
        _conn().execute(
            'INSERT OR REPLACE INTO sessions (id, title, started_at, message_count, workspace_path) '
            "VALUES (?, ?, datetime('now'), 0, ?)",
            (f'promotetest-{i}', f'promotetest-{i}', ws),
        )
    _conn().commit()


def _known_workspaces() -> set[str]:
    from app.services.harness_promote import _known_workspaces as _kw

    return set(_kw())


# ── enumeration ──────────────────────────────────────────────────────────


class TestEnumeration:
    def test_known_workspaces_never_invent_paths(self, tmp_path) -> None:
        wsA = _mk_workspace(tmp_path, 'alpha')
        _seed_sessions([wsA])
        known = _known_workspaces()
        assert wsA in known
        assert str(tmp_path / 'never-seeded') not in known

    def test_home_excluded(self, tmp_path) -> None:
        _seed_sessions([str(Path.home())])
        assert str(Path.home()) not in _known_workspaces()


# ── the ≥2-project bar ───────────────────────────────────────────────────


class TestRecurrenceBar:
    def test_shared_lesson_proposes_across_two_projects(self, tmp_path) -> None:
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass

        wsA = _mk_workspace(tmp_path, 'alpha')
        wsB = _mk_workspace(tmp_path, 'beta')
        _seed_sessions([wsA, wsB])
        pm.upsert_entry(wsA, 'Run ruff before mypy', 'Lint first, then typecheck — mypy noise hides real errors')
        pm.upsert_entry(wsB, 'Run ruff before mypy', 'Lint pass first: mypy errors get buried by lint noise otherwise')

        summary = run_promotion_pass()
        assert summary['ran'] is True
        assert summary['proposalsFiled'] == 1
        assert summary['recurring'] == 1

    def test_single_project_lesson_never_proposes(self, tmp_path) -> None:
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass

        wsA = _mk_workspace(tmp_path, 'alpha')
        _seed_sessions([wsA])
        pm.upsert_entry(wsA, 'Solo lesson', 'Only one project knows this so it must not go global')
        summary = run_promotion_pass()
        assert summary['proposalsFiled'] == 0

    def test_same_project_duplicates_do_not_count_twice(self, tmp_path) -> None:
        """Two similar entries in ONE workspace ≠ recurrence."""
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass

        wsA = _mk_workspace(tmp_path, 'alpha')
        _seed_sessions([wsA])
        pm.upsert_entry(wsA, 'Run ruff before mypy', 'lint first')
        pm.upsert_entry(wsA, 'run-ruff-before-mypy', 'lint first, always')
        summary = run_promotion_pass()
        assert summary['proposalsFiled'] == 0

    def test_sensitive_lesson_blocked(self, tmp_path) -> None:
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass

        wsA = _mk_workspace(tmp_path, 'alpha')
        wsB = _mk_workspace(tmp_path, 'beta')
        _seed_sessions([wsA, wsB])
        pm.upsert_entry(wsA, 'User health medication schedule', 'recurring but sensitive')
        pm.upsert_entry(wsB, 'User health medication schedule', 'recurring but sensitive')
        summary = run_promotion_pass()
        assert summary['proposalsFiled'] == 0

    def test_skill_learning_off_skips_pass(self, tmp_path, monkeypatch) -> None:
        from app.services import harness_promote

        monkeypatch.setattr(
            harness_promote, '_skill_learning_mode', lambda: 'off'
        )
        summary = harness_promote.run_promotion_pass()
        assert summary['ran'] is False
        assert summary.get('reason') == 'skillLearning is off'

    def test_promote_kind_is_valid_for_save_proposal(self) -> None:
        from app.services.harness_self_improve import VALID_KINDS

        assert 'promote' in VALID_KINDS


# ── human gate: approve → copy-on-write with provenance ──────────────────


class TestApprovalAppliesCopyOnWrite:
    def test_end_to_end_promote_fact(self, tmp_path) -> None:
        """Two projects share a lesson → proposal → approve → global fact
        with promoted-from provenance → project files untouched."""
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass

        wsA = _mk_workspace(tmp_path, 'alpha')
        wsB = _mk_workspace(tmp_path, 'beta')
        _seed_sessions([wsA, wsB])
        pm.upsert_entry(wsA, 'Run ruff before mypy', 'Lint first, then typecheck — mypy noise hides real errors')
        pm.upsert_entry(wsB, 'Run ruff before mypy', 'Lint pass first: mypy errors get buried by lint noise otherwise')
        run_promotion_pass()

        from app.services import harness_self_improve

        openPromos = [p for p in harness_self_improve.list_proposals('open') if p['kind'] == 'promote']
        assert len(openPromos) == 1
        row = harness_self_improve.decide_proposal(openPromos[0]['id'], 'approve', 'cross-project lesson')
        assert row['status'] == 'applied'
        assert row['applyResult']['ok'] is True

        promotedKey = row['applyResult']['target']
        fact = memory_store.get_fact(promotedKey)
        assert fact is not None, 'approved promotion must create the global fact'
        assert fact['source'] == f'promoted-from:{wsA}'
        assert fact['title'] == 'Run ruff before mypy'
        assert fact['category'] == 'promoted'
        assert fact['kind'] == 'lesson'
        # Copy-on-write: the project entry stays in BOTH project files.
        assert any(e.title == 'Run ruff before mypy' for e in pm.read_entries(wsA))
        assert any(e.title == 'Run ruff before mypy' for e in pm.read_entries(wsB))

    def test_end_to_end_promote_skill(self, tmp_path) -> None:
        """Same-name project skill in ≥2 workspaces → proposal → approve →
        global skill copy; project originals untouched."""
        from app.services import project_memory as pm  # noqa: F401
        from app.services import skill_service
        from app.services.harness_promote import run_promotion_pass

        wsA = _mk_workspace(tmp_path, 'alpha')
        wsB = _mk_workspace(tmp_path, 'beta')
        _seed_sessions([wsA, wsB])
        skill_service.createSkill(
            name='nsis-deprecation',
            description='MSI is the installer path; NSIS is legacy here',
            body='## When to Use\n\nBuilding installers for this product.',
            workspace=wsA,
        )
        skill_service.createSkill(
            name='nsis-deprecation',
            description='MSI is the installer path; NSIS is legacy here',
            body='## When to Use\n\nBuilding installers for this product.',
            workspace=wsB,
        )
        summary = run_promotion_pass()
        assert summary['crossSkills'] == 1
        assert summary['proposalsFiled'] == 1

        from app.services import harness_self_improve

        openPromos = [p for p in harness_self_improve.list_proposals('open') if p['kind'] == 'promote']
        row = harness_self_improve.decide_proposal(openPromos[0]['id'], 'approve')
        assert row['status'] == 'applied'
        # Global agent root now holds the skill (scope=agent from the
        # global catalogue).
        globalDetail = skill_service.get('nsis-deprecation', '')
        assert globalDetail is not None, 'approved skill promotion must create the global skill'
        # Project copies untouched.
        assert skill_service.get('nsis-deprecation', wsA) is not None
        assert (Path(wsA) / '.aug' / 'skills' / 'nsis-deprecation' / 'SKILL.md').exists()

    def test_reject_records_and_never_rereads(self, tmp_path) -> None:
        """Part 16 anti-drift: a rejected promote draft is never re-filed."""
        from app.services import harness_self_improve
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass

        wsA = _mk_workspace(tmp_path, 'alpha')
        wsB = _mk_workspace(tmp_path, 'beta')
        _seed_sessions([wsA, wsB])
        pm.upsert_entry(wsA, 'Run ruff before mypy', 'lint first')
        pm.upsert_entry(wsB, 'Run ruff before mypy', 'lint first')
        run_promotion_pass()
        openPromos = [p for p in harness_self_improve.list_proposals('open') if p['kind'] == 'promote']
        harness_self_improve.decide_proposal(openPromos[0]['id'], 'reject', 'not actually global')

        # A later pass must NOT re-file the rejected draft.
        summary = run_promotion_pass()
        assert summary['proposalsFiled'] == 0

    def test_approval_never_mutates_project_memory_file(self, tmp_path) -> None:
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass

        wsA = _mk_workspace(tmp_path, 'alpha')
        wsB = _mk_workspace(tmp_path, 'beta')
        _seed_sessions([wsA, wsB])
        pm.upsert_entry(wsA, 'Run ruff before mypy', 'lint first')
        pm.upsert_entry(wsB, 'Run ruff before mypy', 'lint first')
        beforeA = (Path(wsA) / '.aug' / 'memory' / 'memory.md').read_text('utf-8')
        beforeB = (Path(wsB) / '.aug' / 'memory' / 'memory.md').read_text('utf-8')
        run_promotion_pass()

        from app.services import harness_self_improve

        openPromos = [p for p in harness_self_improve.list_proposals('open') if p['kind'] == 'promote']
        harness_self_improve.decide_proposal(openPromos[0]['id'], 'approve')
        assert (Path(wsA) / '.aug' / 'memory' / 'memory.md').read_text('utf-8') == beforeA
        assert (Path(wsB) / '.aug' / 'memory' / 'memory.md').read_text('utf-8') == beforeB


# ── demote suggestions (measurement) ─────────────────────────────────────


class TestDemoteSuggestions:
    def test_non_trigger_promoted_item_earns_demote_suggestion(self, tmp_path) -> None:
        """Promotion approved long ago + zero use → demote suggestion
        (observation kind) — never a deletion."""
        from app.services import harness_self_improve
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass, suggest_demotions

        wsA = _mk_workspace(tmp_path, 'alpha')
        wsB = _mk_workspace(tmp_path, 'beta')
        _seed_sessions([wsA, wsB])
        pm.upsert_entry(wsA, 'Run ruff before mypy', 'lint first')
        pm.upsert_entry(wsB, 'Run ruff before mypy', 'lint first')
        run_promotion_pass()
        openPromos = [p for p in harness_self_improve.list_proposals('open') if p['kind'] == 'promote']
        row = harness_self_improve.decide_proposal(openPromos[0]['id'], 'approve')

        # Age the decision past the demote window by rewriting decidedAt.
        old = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 40 * 86400))
        ppath = (
            Path(str(row.get('_path'))) if row.get('_path') else None
        )
        from app.services.harness_self_improve import _proposals_dir

        ppath = _proposals_dir() / f"{row['id']}.json"
        stored = json.loads(ppath.read_text('utf-8'))
        stored['decidedAt'] = old
        ppath.write_text(json.dumps(stored, indent=2), encoding='utf-8')

        suggestions = suggest_demotions()
        assert any('Run ruff before mypy' in str(s.get('target')) for s in suggestions)
        # The suggestion is an observation proposal — nothing deleted.
        obs = [
            p
            for p in harness_self_improve.list_proposals('open')
            if p.get('payload', {}).get('demoteSuggestion')
        ]
        assert obs, 'demote suggestion must land in the same review queue'

    def test_used_promoted_item_no_demote(self, tmp_path) -> None:
        from app.services import harness_self_improve
        from app.services import project_memory as pm
        from app.services.harness_promote import run_promotion_pass, suggest_demotions

        wsA = _mk_workspace(tmp_path, 'alpha')
        wsB = _mk_workspace(tmp_path, 'beta')
        _seed_sessions([wsA, wsB])
        pm.upsert_entry(wsA, 'Run ruff before mypy', 'lint first')
        pm.upsert_entry(wsB, 'Run ruff before mypy', 'lint first')
        run_promotion_pass()
        openPromos = [p for p in harness_self_improve.list_proposals('open') if p['kind'] == 'promote']
        row = harness_self_improve.decide_proposal(openPromos[0]['id'], 'approve')
        promotedKey = row['applyResult']['target']

        # The promoted fact got used (recalled) — no demote suggestion.
        from app.services.memory_conn import conn as _conn

        _conn().execute(
            "UPDATE facts SET use_count = 3, last_used_at = datetime('now') WHERE fact_key = ?",
            (promotedKey,),
        )
        _conn().commit()
        from app.services.harness_self_improve import _proposals_dir

        ppath = _proposals_dir() / f"{row['id']}.json"
        stored = json.loads(ppath.read_text('utf-8'))
        stored['decidedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 40 * 86400))
        ppath.write_text(json.dumps(stored, indent=2), encoding='utf-8')
        suggestions = suggest_demotions()
        assert not any('Run ruff before mypy' in str(s.get('target')) for s in suggestions)


# ── router surface ───────────────────────────────────────────────────────


class TestPromotionRouter:
    def test_run_endpoint_409_when_off(self, monkeypatch) -> None:
        from app.main import app
        from app.services import harness_promote
        from fastapi.testclient import TestClient

        monkeypatch.setattr(harness_promote, '_skill_learning_mode', lambda: 'off')
        with TestClient(app) as client:
            resp = client.post('/api/harness/proposals/promotion/run')
            assert resp.status_code == 409

    def test_run_endpoint_and_demote_scan(self) -> None:
        from app.main import app
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            resp = client.post('/api/harness/proposals/promotion/run?force=true')
            assert resp.status_code == 200
            assert resp.json()['ran'] is True
            resp2 = client.post('/api/harness/proposals/promotion/demote-scan')
            assert resp2.status_code == 200
            assert 'suggestions' in resp2.json()


# ── skillLearning config ─────────────────────────────────────────────────


class TestSkillLearningConfig:
    def test_default_is_extract_only(self) -> None:
        from app.services.harness_promote import _skill_learning_mode

        assert _skill_learning_mode() == 'extract-only'

    def test_config_validation_rejects_bad_value(self) -> None:
        from app.services.brain_config_service import validatePatch

        ok, err = validatePatch({'skillLearning': 'sometimes'})
        assert not ok
        ok2, _ = validatePatch({'skillLearning': 'full'})
        assert ok2

    def test_off_via_persisted_config(self, monkeypatch) -> None:
        from app.services import harness_promote
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({'skillLearning': 'off'})
        try:
            assert harness_promote._skill_learning_mode() == 'off'
        finally:
            saveBrainConfig({'skillLearning': 'extract-only'})


# ── Phase E cleanup: dead skills-segment path ────────────────────────────


class TestDeadSkillsSegmentPath:
    def test_get_skills_segments_deleted(self) -> None:
        from app.services.workbench import prompt_segments_cache as seg

        assert not hasattr(seg, 'get_skills_segments')
        assert not hasattr(seg, '_build_skills_segments')
        # Compat surface stays for skill_service + fixtures.
        assert callable(seg.clear)
        assert callable(seg.stats)
        assert seg.MEMORY_BLOCK and seg.MEMORY_NUDGE_BLOCK

    def test_clear_is_safe_noop(self) -> None:
        from app.services.workbench import prompt_segments_cache as seg

        seg.clear()  # must not raise
        assert seg.stats()['skills_cached'] is False
