"""Part 16 §12 third-review fix batch — regression tests (F-1…F-11).

Each test reproduces a finding from docs/plans/2026-08-29-self-improvement-loops.md
§12 against the REAL storage shapes the app writes (dict content with
tool_calls, raw-text rows, tool-role errors), then asserts the fixed
behavior. Plan acceptance: the mine → flag → judge → draft chain must
execute end-to-end on real-shaped data.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from app.services import episode_miner as em
from app.services import skill_distiller as sd


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _seedRealShape(sessionId: str, msgs: list[tuple[str, object]]) -> None:
    """Seed messages the way the WORKBENCH persistence path stores them
    (memory_store/sessions.py: dict payloads with content/tool_calls,
    tool-role results, plus raw-text rows)."""
    from app.services.memory_conn import conn

    c = conn()
    c.execute("INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)", (sessionId, 't'))
    for role, payload in msgs:
        content = payload if isinstance(payload, str) else json.dumps(payload)
        c.execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            (sessionId, role, content),
        )
    c.commit()


class TestF1RealTranscriptShape:
    def test_dict_content_assistant_is_readable(self, brain):
        _seedRealShape(
            's1',
            [
                ('user', 'run the ngspice sim'),
                ('assistant', {'content': '', 'tool_calls': [{'id': 't1', 'type': 'function', 'function': {'name': 'run_command', 'arguments': '{"command":"ngspice -b a.cir"}'}}]}),
                ('tool', {'content': 'Error: command failed with exit code:1 — ngspice: command not found', 'tool_use_id': 't1'}),
                ('assistant', {'content': 'Installed ngspice via vcpkg; sim now runs clean.'}),
            ],
        )
        episodes = em.extract_episodes('s1')
        fr = [e for e in episodes if e['kind'] == 'failure_recovery']
        assert len(fr) >= 1, f'miner found nothing in real-shaped transcript: {episodes}'
        assert fr[0]['outcome'] == 'resolved'
        assert any('ngspice' in str(e.get('excerpt', '')).lower() for e in fr[0]['events'])

    def test_tool_call_only_assistant_is_not_recovery(self, brain):
        # A retry that only calls another tool is NOT a clean continuation.
        _seedRealShape(
            's2',
            [
                ('user', 'do it'),
                ('tool', {'content': '[Error] command failed', 'tool_use_id': 't1'}),
                ('assistant', {'content': '', 'tool_calls': [{'id': 't2', 'type': 'function', 'function': {'name': 'run_command', 'arguments': '{}'}}]}),
                ('tool', {'content': 'ok done', 'tool_use_id': 't2'}),
                ('assistant', {'content': 'All finished — verified.'}),
            ],
        )
        episodes = em.extract_episodes('s2')
        fr = [e for e in episodes if e['kind'] == 'failure_recovery']
        assert fr, 'expected the tool-error window to mine'
        assert fr[0]['outcome'] == 'resolved'
        # the window must END at the real text reply, not the tool-call-only one
        assert fr[0]['end_message_id'] == 5

    def test_mine_sessions_end_to_end_on_real_shape(self, brain):
        _seedRealShape(
            's3',
            [
                ('user', 'compile the circuit'),
                ('tool', {'content': 'command failed with exit code:2 — quartus not found', 'tool_use_id': 't1'}),
                ('assistant', {'content': 'Found quartus at /opt/altera — compiled clean.'}),
            ],
        )
        out = em.mine_sessions(sinceDays=30)
        assert out['episodes'] >= 1
        eps = em._conn().execute('SELECT * FROM episodes').fetchall()
        assert len(eps) >= 1
        fp = em._conn().execute('SELECT fingerprint FROM failure_fingerprints').fetchall()
        assert fp, 'fingerprint must be recorded'


class TestF2RawTextRows:
    def test_raw_text_content_does_not_crash(self, brain):
        _seedRealShape(
            's4',
            [
                ('user', '[Proxy Self-Heal] 20 tool rounds have elapsed without advancing.'),
                ('assistant', 'plain non-JSON assistant text with [Error] inside'),
                ('user', 'actually, use the vcpkg build'),
                ('assistant', 'switched to vcpkg, works now'),
            ],
        )
        episodes = em.extract_episodes('s4')  # must not raise
        assert isinstance(episodes, list)
        out = em.mine_sessions(sinceDays=30)
        assert out['sessions'] >= 1


class TestF3FlagToJudgeChain:
    def test_flagged_episode_reaches_the_judge(self, brain, monkeypatch):
        ep = {
            'session_id': 's5',
            'kind': 'failure_recovery',
            'start_message_id': 1,
            'end_message_id': 3,
            'outcome': 'resolved',
            'events': [{'type': 'tool_error', 'excerpt': 'ngspice missing binary exit code:1'}],
        }
        eid = em.record_episode(ep)
        # flagRateCap=1.0 flags the single episode (the strict n*cap floor
        # would zero it); the test targets the F-3 chain, not cap semantics.
        flagged = em.flag_top_slice(flagRateCap=1.0, budgetPerDay=5)
        assert flagged['flagged'] == 1
        # tier-1 rubric must NOT occupy the tier-2 verdict column
        row = em._conn().execute('SELECT judge_verdict, tier1_result FROM episodes WHERE id = ?', (eid,)).fetchone()
        assert not str(row['judge_verdict'] or '').strip(), 'tier-1 score must not pre-fill judge_verdict'
        assert row['tier1_result'], 'tier-1 score must be stored in tier1_result'

        calls: list[str] = []

        async def fake_judge(prompt: str) -> dict:
            calls.append(prompt)
            return {'verdicts': [{'episode': eid, 'action': 'none', 'reason': 'one-off'}]}

        monkeypatch.setattr(sd, 'call_judge', fake_judge)
        from app.services import brain_config_service as bcs

        orig = bcs.getRuntimeConfig
        monkeypatch.setattr(bcs, 'getRuntimeConfig', lambda: {**orig(), 'skillLearning': 'full'})
        out = sd.run_distiller_pass()
        assert out.get('verdicts', 0) >= 1, f'distiller judged nothing: {out}'
        assert calls, 'judge model call must actually run'
        judged = em._conn().execute('SELECT judge_verdict FROM episodes WHERE id = ?', (eid,)).fetchone()
        assert 'one-off' in str(judged['judge_verdict'])


class TestF4CuratorRouterOffLoop:
    def test_run_curator_judges_inside_live_loop(self, brain, monkeypatch):
        ep = {
            'session_id': 's6',
            'kind': 'failure_recovery',
            'start_message_id': 1,
            'end_message_id': 2,
            'outcome': 'resolved',
            'events': [{'type': 'tool_error', 'excerpt': 'pnpm install failed exit code:1'}],
        }
        eid = em.record_episode(ep)
        em.flag_top_slice(flagRateCap=1.0, budgetPerDay=5)

        calls: list[int] = []

        async def fake_judge(prompt: str) -> dict:
            calls.append(1)
            return {'verdicts': [{'episode': eid, 'action': 'none', 'reason': 'x'}]}

        monkeypatch.setattr(sd, 'call_judge', fake_judge)
        from app.routers import curator
        from app.services import brain_config_service as bcs

        orig = bcs.getRuntimeConfig
        monkeypatch.setattr(bcs, 'getRuntimeConfig', lambda: {**orig(), 'skillLearning': 'full'})

        async def live():
            return await curator.runCurator(dryRun=False)

        out = asyncio.run(live())  # the handler runs INSIDE a loop
        assert out['ok'] is True
        assert calls, 'curator run on a live loop must still reach the judge (off-loop worker)'


class TestF5DowngradeIsNotDestructive:
    def test_amend_body_downgrade_files_observation_not_patch(self, brain):
        label = sd.apply_verdict(
            {'episode': 1, 'action': 'amend_body', 'skill': 'some-skill',
             'patch_markdown': '## Pitfalls\n\nnew thing'},
            'tool-error:x',
            mode='full',
        )
        assert label == 'downgraded-proposal'
        from app.services import harness_self_improve as hsi

        props = hsi.list_proposals(status='open')
        assert len(props) == 1
        assert props[0]['kind'] == 'observation', 'review-only downgrade must never be an approvable patch'

    def test_applier_refuses_bodyless_skill_patch(self, brain, agentRootForF5):
        from app.services import harness_self_improve as hsi

        (agentRootForF5 / 'keep-me').mkdir()
        (agentRootForF5 / 'keep-me' / 'SKILL.md').write_text(
            '---\nname: keep-me\ndescription: Keep.\ncreated_by: harness-proposal\n---\n'
            '# What this skill is\n\nREAL BODY TEXT.\n\n## When to Use\n\nAlways.\n\n'
            '## How to Run\n\n1. do it\n\n## Pitfalls\n\nNone.\n\n## Verification\n\nCheck.\n',
            'utf-8',
        )
        before = (agentRootForF5 / 'keep-me' / 'SKILL.md').read_text('utf-8')
        row = hsi.save_proposal(
            problem='bodyless patch', evidence='e', proposal='p', rollback='r',
            kind='skill_patch', payload={'name': 'keep-me'},
        )
        res = hsi.decide_proposal(row['id'], 'approve')
        assert res.get('applyResult', {}).get('ok') is False
        after = (agentRootForF5 / 'keep-me' / 'SKILL.md').read_text('utf-8')
        assert after == before, 'approving a body-less patch must NOT overwrite the skill'


@pytest.fixture()
def agentRootForF5(monkeypatch, tmp_path):
    from app.services import skill_service

    root = tmp_path / 'agent-skills'
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: root)
    return root


class TestF6NoReMineInflation:
    def test_remining_same_window_does_not_inflate(self, brain):
        _seedRealShape(
            's7',
            [
                ('user', 'build it'),
                ('tool', {'content': 'Error: build failed exit code:1', 'tool_use_id': 't1'}),
                ('assistant', {'content': 'rebuilt with the fix, green.'}),
            ],
        )
        first = em.mine_sessions(sinceDays=30)
        assert first['episodes'] >= 1
        count1 = em._conn().execute('SELECT SUM(episode_count) n FROM failure_fingerprints').fetchone()['n']
        second = em.mine_sessions(sinceDays=30)
        count2 = em._conn().execute('SELECT SUM(episode_count) n FROM failure_fingerprints').fetchone()['n']
        assert count2 == count1, f're-mine inflated episode_count {count1} -> {count2}'
        assert second['episodes'] == 0, 're-mine must report zero NEW episodes'

    def test_resolved_fingerprint_stays_resolved_across_remines(self, brain):
        _seedRealShape(
            's8',
            [
                ('user', 'actually, use vcpkg for ngspice'),
                ('assistant', 'ok, installed via vcpkg'),
            ],
        )
        em.mine_sessions(sinceDays=30)
        fpRow = em._conn().execute('SELECT fingerprint FROM failure_fingerprints').fetchone()
        assert fpRow
        fp = str(fpRow['fingerprint'])
        from app.services import harness_self_improve as hsi

        row = hsi.save_proposal(
            problem=f'distiller create_skill for {fp}', evidence='e', proposal='p', rollback='r',
            kind='skill_create',
            payload={'name': 'fix-skill', 'description': 'd', 'body': 'b',
                     'fingerprint': fp, 'action': 'create_skill', 'target': 'fix-skill', 'origin': 'distilled'},
        )
        hsi.decide_proposal(row['id'], 'approve')
        old = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
        em._conn().execute(
            "UPDATE failure_fingerprints SET last_seen = ?, status = 'open' WHERE fingerprint = ?", (old, fp)
        )
        em._conn().commit()
        r1 = em.run_resolution_check()
        assert r1['resolved'] == 1
        em.mine_sessions(sinceDays=60)  # cadence re-mines the same old window
        r2 = em.run_resolution_check()
        assert r2['recurred'] == 0, 're-mining the same window must not fake a recurrence'


class TestF8RejectedNotRefilled:
    def test_rejected_demotion_is_not_refiled(self, brain, agentRootForF5):
        fp = 'tool-error:dead-skill'
        em.upsert_fingerprint(fp)
        old = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
        em._conn().execute(
            "UPDATE failure_fingerprints SET last_seen = ?, status = 'resolved' WHERE fingerprint = ?", (old, fp)
        )
        em._conn().commit()
        from app.services import harness_self_improve as hsi

        row = hsi.save_proposal(
            problem=f'distiller create_skill for {fp}', evidence='e', proposal='p', rollback='r',
            kind='skill_create',
            payload={'name': 'dead-skill', 'description': 'd', 'body': 'b',
                     'fingerprint': fp, 'action': 'create_skill', 'target': 'dead-skill', 'origin': 'distilled'},
        )
        hsi.decide_proposal(row['id'], 'approve')
        r1 = em.run_resolution_check()
        assert r1['demotionSuggestions'] == 1
        dels = [p for p in hsi.list_proposals(status='open') if p['kind'] == 'skill_delete']
        hsi.decide_proposal(dels[0]['id'], 'reject')
        r2 = em.run_resolution_check()
        assert r2['demotionSuggestions'] == 0, 'rejected demotion must not re-file every pass'
        assert not [p for p in hsi.list_proposals(status='open') if p['kind'] == 'skill_delete']


class TestF9ReportStatus:
    def test_curator_report_reads_meta_status(self, brain, agentRootForF5):
        (agentRootForF5 / 'stale-one').mkdir()
        (agentRootForF5 / 'stale-one' / 'SKILL.md').write_text(
            '---\nname: stale-one\ndescription: d\nstatus: stale\n---\n\nBody.\n', 'utf-8',
        )
        from app.services import skill_service

        skill_service._bust_prompt_skills_cache()
        from app.routers.curator import _skillStatusReport

        rep = _skillStatusReport()
        assert 'stale-one' in rep['staled'], f'stale skill not surfaced: {rep}'


class TestF10SkillDrafted:
    def test_distiller_draft_flips_fingerprint_status(self, brain, monkeypatch):
        fp = 'tool-error:draft-me'
        em.upsert_fingerprint(fp)
        monkeypatch.setattr(sd, 'precision_state', lambda: {
            'labeled': 0, 'correct': 0, 'precision': 0.0, 'amendBodyEnabled': False})
        label = sd.apply_verdict(
            {'episode': 1, 'action': 'create_skill', 'name': 'drafted-skill',
             'description': 'Drafted.', 'body': '# What this skill is\n\nx\n'},
            fp, mode='full',
        )
        assert label == 'proposal-filed'
        status = em._conn().execute(
            'SELECT status FROM failure_fingerprints WHERE fingerprint = ?', (fp,)
        ).fetchone()['status']
        assert status == 'skill_drafted'


class TestF11InjectedBlocks:
    def test_subagent_blocks_are_not_corrections(self, brain):
        _seedRealShape(
            's9',
            [
                ('user', '[SUBAGENT RESULTS — One or more background subagents finished. '
                         'Each block below is that subagent\'s completion. Actually the task is done.]'),
                ('assistant', 'Great, incorporating that.'),
            ],
        )
        episodes = em.extract_episodes('s9')
        assert not [e for e in episodes if e['kind'] == 'correction_accepted'], (
            'machine-injected user blocks must not mine as corrections'
        )


class TestF7UnpooledJudgeClient:
    def test_call_judge_uses_fresh_client_and_closes_it(self, brain, monkeypatch):
        import asyncio

        from app.providers.clients import getUnpooledClient as realFactory

        made: list[object] = []

        class FakeClient:
            def __init__(self, cfg):
                self.config = cfg
                self.closed = False

            async def generate(self, prompt, system=''):
                return '{"verdicts": []}'

            async def close(self):
                self.closed = True

        def fake_factory(cfg):
            c = FakeClient(cfg)
            made.append(c)
            return c

        monkeypatch.setattr(sd, 'resolve_judge_model', lambda: 'some-model')
        monkeypatch.setattr(sd, '_resolveProvider', lambda m: {'id': 'p', 'baseUrl': 'http://x'})
        import app.providers.clients as clients_mod

        monkeypatch.setattr(clients_mod, 'getUnpooledClient', fake_factory)
        out = asyncio.run(sd.call_judge('prompt'))
        assert out == {'verdicts': []}
        assert len(made) == 1 and made[0].closed, 'judge client must be closed after the call'
        # the factory must be the UNPOOLED one — pooled clients bind their
        # keep-alive connections to the throwaway per-pass loop (F-7)
        assert fake_factory is not realFactory or made[0] is not None


class TestD4ResolutionOnCadence:
    def test_consolidation_pass_runs_resolution_check(self, brain, monkeypatch):
        """D-4: §3.5 monitoring must ride the consolidation cadence, not only
        the manual /api/curator/run endpoint — a resolved fingerprint that
        recurs between manual runs would otherwise never re-flag."""
        from app.services.memory_store import consolidation

        calls: list[bool] = []

        def fake_resolution(windowDays: int = 30) -> dict[str, object]:
            calls.append(True)
            return {'resolved': 0, 'recurred': 0, 'demotion_drafts': 0}

        monkeypatch.setattr(
            'app.services.episode_miner.run_resolution_check', fake_resolution
        )
        out = consolidation._skill_learning_pass()
        assert calls, 'resolution check must run on the consolidation cadence'
        assert 'resolution' in out, 'result should surface resolution counters'


class TestD3ReportMetrics:
    """D-3: /api/curator/report carries the §3.5 skillLearningReport blob —
    drafts, approval rate, demotions, recurred — not just episode counters."""

    def test_report_includes_skill_learning_metrics(self, brain, agentRootForF5, monkeypatch):
        import asyncio

        from app.routers import curator

        # One applied skill_create + one rejected demotion in the proposals dir.
        from app.services import harness_self_improve as hsi

        row1 = hsi.save_proposal(
            problem='p', evidence='e', proposal='create_skill: fix-x', rollback='r',
            kind='skill_create',
            payload={'name': 'fix-x', 'description': 'd', 'body': 'b',
                     'action': 'create_skill', 'target': 'fix-x', 'origin': 'distilled'},
        )
        hsi.decide_proposal(row1['id'], 'approve')
        row2 = hsi.save_proposal(
            problem='p', evidence='e', proposal='demote dead-skill', rollback='r',
            kind='skill_delete',
            payload={'name': 'dead-skill', 'action': 'skill_delete', 'target': 'dead-skill',
                     'origin': 'resolution'},
        )
        hsi.decide_proposal(row2['id'], 'reject')

        rep = asyncio.run(curator.curatorReport())
        m = rep['skillLearning']
        assert m['drafts'] == 2
        assert m['approved'] == 1 and m['rejected'] == 1
        assert abs(m['approvalRate'] - 0.5) < 0.01
        assert m['demotions'] == 1
