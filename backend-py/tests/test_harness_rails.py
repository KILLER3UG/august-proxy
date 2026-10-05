"""Item 14 — the rails on automatic skill evolution.

One question, answered for one proposal before the reviewer's KEEP is allowed to
become a write. Autonomy ships OFF, so the interesting failure mode is not "the
rails are too strict" — it is a rule that silently defaults to allowing, or a
refusal that names nothing. Two cases are the ones the plan demanded by name: a
proposal whose evidence came from fetched content must be held even when the
reviewer said KEEP, and the kill switch must really be what stops the write.

Nothing here reaches a provider: the reviewer is faked at the gate, exactly as
in test_reviewer_pass.py.
"""

from __future__ import annotations

import pytest
from app.services import episode_miner
from app.services import harness_rails as rails
from app.services import harness_self_improve as hsi


@pytest.fixture
def brain(isolatedData):
    from app.services import memory_store

    memory_store.init()
    return isolatedData


def _configure(**overrides) -> None:
    """Write brain-config through the real door, so the key allow-list is tested.

    `saveBrainConfig` takes a FLAT camelCase patch — the nested
    auxiliary.cognitive.orchestrator shape is what it writes, not what it reads.
    """
    from app.services.brain_config_service import saveBrainConfig

    ok, err, _merged = saveBrainConfig(dict(overrides))
    assert ok, f'the rails config keys must be settable through the API door: {err}'


def _armed(brain, **extra) -> None:
    """Autonomy on with burn-in out of the way: only the rule under test can fire."""
    _configure(skillAutonomy=True, autonomyBurnInCount=0, **extra)


def _episode(kind: str, *, quarantined: bool = False) -> int:
    eid = episode_miner.save_episode(
        {
            'session_id': 'ses_rails',
            'kind': kind,
            'start_message_id': 1,
            'end_message_id': 3,
            'events': [{'role': 'user', 'text': "Don't rebuild, just restart the container."}],
            'outcome': 'resolved',
            'fingerprint_id': f'fp-{kind}-{eid_suffix()}',
        }
    )
    if quarantined:
        conn = episode_miner._conn()
        conn.execute('UPDATE episodes SET quarantined = 1 WHERE id = ?', (eid,))
        conn.commit()
    return eid


def eid_suffix() -> int:
    """A fresh suffix per call so same-kind episodes are not deduped away."""
    global _EID_COUNTER
    _EID_COUNTER += 1
    return _EID_COUNTER


_EID_COUNTER = 0
_PROBLEM_COUNTER = 0


def _unique(tag: str) -> str:
    """A fresh suffix per call, so same-kind episodes and same-kind proposals
    are not deduped away by the store's own guards."""
    global _EID_COUNTER
    _EID_COUNTER += 1
    return f'{tag}-{_EID_COUNTER}'


def _proposal(
    kind: str = 'skill_patch',
    name: str = 'rails-skill',
    body: str = '# Rails Skill\n\nRestart the container instead of rebuilding it.\n',
    evidence: str = 'the user corrected this twice, in their own words',
    episodeKinds: tuple[str, ...] = ('user_correction',),
    episodeIds: list[int] | None = None,
    skill: str = '',
) -> str:
    """Files one proposal. `skill` pins the skill name (the per-skill rail needs
    two rows naming the SAME skill); otherwise each row gets its own, because
    the store refuses two open rows with the same kind + problem."""
    global _PROBLEM_COUNTER
    _PROBLEM_COUNTER += 1
    skillName = skill or _unique(name)
    ids = episodeIds if episodeIds is not None else [_episode(k) for k in episodeKinds]
    row = hsi.save_proposal(
        problem=f'the skill tells the agent to rebuild every time [{_PROBLEM_COUNTER}]',
        evidence=evidence,
        proposal='amend the body to restart only',
        rollback='restore the previous version from .versions',
        kind=kind,
        payload={
            'name': skillName,
            'description': 'container flow',
            'body': body,
            'trigger': 'container',
            'episodeIds': ids,
            'origin': 'distilled',
        },
    )
    return str(row['id'])


def _verdict(pid: str) -> dict:
    return rails.auto_apply_allowed(hsi.get_proposal(pid))


class TestTheSwitch:
    def test_autonomy_off_holds_everything(self, brain):
        pid = _proposal()
        out = _verdict(pid)
        assert out['allowed'] is False
        assert out['rule'] == 'autonomy-off', out
        assert out['reason'], 'a refusal must name itself to the human'

    def test_the_default_is_off_and_the_keys_are_real_config(self, brain):
        from app.services.brain_config_service import allowedKeys, getRuntimeConfig

        assert {'skillAutonomy', 'autoApplyPerDay', 'autonomyBurnInCount'} <= set(allowedKeys)
        assert getRuntimeConfig().get('skillAutonomy') is False

    def test_clean_and_armed_is_allowed(self, brain):
        _armed(brain)
        out = _verdict(_proposal())
        assert out['allowed'] is True, out


class TestHardLimitCategories:
    """Only skill prose may auto-apply, and that is an allow-list, not a deny
    list: a kind added tomorrow is held by default."""

    @pytest.mark.parametrize(
        'kind',
        ['skill_delete', 'brain_config', 'retire', 'promote', 'revert', 'observation'],
    )
    def test_a_hard_kind_is_held(self, brain, kind):
        _armed(brain)
        pid = _proposal(kind=kind, episodeKinds=('user_correction',))
        out = _verdict(pid)
        assert out['allowed'] is False
        assert out['rule'] == 'hard-kind', out

    def test_the_allow_list_is_the_two_skill_writes(self, brain):
        assert rails.AUTO_APPLIABLE_KINDS == frozenset({'skill_create', 'skill_patch'})
        assert set(hsi.VALID_KINDS) - rails.AUTO_APPLIABLE_KINDS == rails.HARD_KINDS


class TestEvidenceProvenance:
    def test_tool_output_is_not_trusted_evidence(self, brain):
        _armed(brain)
        out = _verdict(_proposal(episodeKinds=('tool_error',)))
        assert out['allowed'] is False
        assert out['rule'] == 'untrusted-evidence', out

    def test_a_proposal_citing_no_episode_is_not_trusted(self, brain):
        _armed(brain)
        out = _verdict(_proposal(episodeKinds=()))
        assert out['allowed'] is False
        assert out['rule'] == 'untrusted-evidence', out

    def test_a_quarantined_episode_is_not_evidence(self, brain):
        """Item 5's 41 invented episodes are still rows. A proposal citing one
        must not reach an auto-apply on the strength of a mined nothing."""
        _armed(brain)
        eid = _episode('user_correction', quarantined=True)
        out = _verdict(_proposal(episodeIds=[eid]))
        assert out['allowed'] is False
        assert out['rule'] == 'untrusted-evidence', out

    def test_a_url_in_the_evidence_is_fetched_content(self, brain):
        _armed(brain)
        out = _verdict(_proposal(evidence='see https://example.com/docs, it says to rebuild'))
        assert out['allowed'] is False
        assert out['rule'] == 'untrusted-evidence', out


class TestContentHardLimits:
    @pytest.mark.parametrize(
        'body',
        [
            '# S\n\n```bash\nrm -rf ./build\n```\n',
            '# S\n\nFetch https://api.example.com/skills before running.\n',
            '# S\n\nSend the api key in the Authorization header.\n',
        ],
    )
    def test_a_skill_that_can_act_is_held(self, brain, body):
        _armed(brain)
        out = _verdict(_proposal(body=body))
        assert out['allowed'] is False
        assert out['rule'] == 'unsafe-content', out


class TestRateAndBurnIn:
    def test_the_daily_budget_is_enforced(self, brain):
        _armed(brain, autoApplyPerDay=2)
        for i in range(2):
            pid = _proposal(name=f'budgeted-{i}')
            assert _verdict(pid)['allowed'] is True
            rails.record_auto_apply(pid, f'budgeted-{i}')
        out = _verdict(_proposal(name='budgeted-late'))
        assert out['allowed'] is False
        assert out['rule'] == 'daily-limit', out

    def test_one_change_per_skill_per_day(self, brain):
        _armed(brain, autoApplyPerDay=10)
        pid = _proposal(skill='same-skill')
        assert _verdict(pid)['allowed'] is True
        rails.record_auto_apply(pid, 'same-skill')
        out = _verdict(_proposal(skill='same-skill'))
        assert out['allowed'] is False
        assert out['rule'] == 'same-skill-today', out
        # …and a different skill is not held by it.
        assert _verdict(_proposal(skill='other-skill'))['allowed'] is True

    def test_burn_in_holds_the_first_clean_ones(self, brain):
        # The daily cap is lifted well above the burn-in window here: burn-in is
        # what this test is about, and the two rails would otherwise both fire.
        _configure(skillAutonomy=True, autonomyBurnInCount=2, autoApplyPerDay=10)
        first = _verdict(_proposal(name='burn-1'))
        assert first['allowed'] is False
        assert first['rule'] == 'burn-in', first
        rails.record_auto_apply('prop_seeded_1', 'burn-1')
        rails.record_auto_apply('prop_seeded_2', 'burn-2')
        out = _verdict(_proposal(name='burn-3'))
        assert out['allowed'] is True, out

    def test_burn_in_at_zero_disables_the_hold(self, brain):
        _armed(brain)
        assert _verdict(_proposal())['allowed'] is True


class TestTheReviewerPathIsGated:
    """The rails are not advice a caller can read and ignore: they sit on the one
    path from a KEEP to a write."""

    def test_fetched_evidence_is_held_even_when_the_reviewer_says_keep(self, brain, monkeypatch):
        _armed(brain)
        pid = _proposal(evidence='the page at https://vendor.example/changelog says so')
        _patch_reviewer(monkeypatch, 'KEEP — the gap is real')
        out = hsi.run_reviewer_pass()
        assert out['reviewed'] >= 1, out
        assert out['applied'] == 0, out
        assert hsi.get_proposal(pid)['status'] == 'open', 'the required hold'

    def test_the_kill_switch_is_the_only_thing_holding_it(self, brain, monkeypatch):
        pid = _proposal(kind='skill_create', name='switched-off')
        _patch_reviewer(monkeypatch, 'KEEP — durable and justified')
        out = hsi.run_reviewer_pass()
        assert out['applied'] == 0, out
        assert hsi.get_proposal(pid)['status'] == 'open', 'autonomy off must not write'

        _armed(brain)
        pid2 = _proposal(kind='skill_create', name='switched-on')
        _patch_reviewer(monkeypatch, 'KEEP — durable and justified')
        out2 = hsi.run_reviewer_pass()
        assert out2['applied'] == 1, out2
        assert hsi.get_proposal(pid2)['status'] == 'applied', hsi.get_proposal(pid2)


class TestTheRuleNamesAreClosed:
    def test_every_refusal_names_a_declared_rule(self, brain):
        """A refusal naming an unknown rule means a branch was added without a
        name for it — which is how a guard starts defaulting to allowing."""
        _armed(brain)
        cases = [
            _proposal(kind='skill_delete'),
            _proposal(episodeKinds=('tool_error',)),
            _proposal(body='# S\n\n```bash\nrm -rf x\n```\n'),
            _proposal(evidence='https://a.example/x'),
            _proposal(episodeKinds=()),
            _proposal(),
        ]
        for pid in cases:
            out = _verdict(pid)
            if out['allowed']:
                continue
            assert out['rule'] in rails.RULES, f'{out!r} names no declared rule'

    def test_an_absent_rule_is_a_bug_not_a_pass(self, brain):
        """`allowed` is only ever set together with rule 'allowed'; anything
        else must carry a reason, so the inbox line can never be empty."""
        _armed(brain)
        for pid in [_proposal(), _proposal(kind='revert')]:
            out = _verdict(pid)
            assert out['rule'], out
            assert (out['allowed'] or out['reason']), out


def _patch_reviewer(monkeypatch, reply: str):
    """Force the gate to hand back a fake reviewer that says `reply`."""

    class _Client:
        def __init__(self):
            self.calls: list = []

        async def __call__(self, prompt):
            self.calls.append(prompt)
            return reply

    client = _Client()
    monkeypatch.setattr(
        'app.services.harness_self_improve.resolve_independent_reviewer',
        lambda producer, hint='': (client, ''),
    )
    return client


class TestAnAmbiguousVerdictNeverActs:
    """Item 10 pinned the fail-closed rule with the switch off. That is the easy
    half: nothing could apply anyway. These run with the rails ARMED and a clean
    proposal, so the only thing standing between a garbled answer and a write is
    the verdict parser itself."""

    @pytest.mark.parametrize(
        'reply',
        [
            'KEEP DISCARD',           # both words: a model that could not decide
            'maybe KEEP if you like', # neither word leading
            '',                       # empty
            '   ',
            'KEEP? DISCARD?',
            'approved',
            '42',
        ],
    )
    def test_a_garbled_answer_is_unavailable_and_writes_nothing(self, brain, monkeypatch, reply):
        _armed(brain)
        name = 'rails-ambiguous'
        pid = _proposal(skill=name)
        _patch_reviewer(monkeypatch, reply)

        out = hsi.run_reviewer_pass()
        row = hsi.get_proposal(pid)
        assert out['applied'] == 0, (reply, out)
        assert row['status'] == 'open', (reply, row)
        assert row['review']['verdict'] == 'unavailable', (reply, row)
        assert row['review']['reason'], 'a refusal has to name itself'
        # And the skill file is untouched: the applier never ran.
        from app.services import skill_service

        assert skill_service.get(name) is None or 'v2' not in str(
            skill_service.get(name).get('body', '')
        ), (reply, skill_service.get(name))

    def test_the_verdict_parser_itself_refuses_a_tie(self, brain):
        """The parser is the whole gate, so assert on its output directly: one
        word leading is a verdict, anything else is not."""
        import asyncio

        _armed(brain)

        class _Reply:
            def __init__(self, text):
                self.text = text

            async def __call__(self, prompt):
                return self.text

        row = {'problem': 'p', 'evidence': 'e', 'proposal': 'q', 'rollback': 'r'}
        for reply, expect in (
            ('KEEP — one word leading is a verdict', 'KEEP'),
            ('DISCARD — not durable', 'DISCARD'),
            ('KEEP DISCARD — both', 'unavailable'),
            ('perhaps KEEP', 'unavailable'),
            ('', 'unavailable'),
        ):
            verdict, reason = asyncio.run(
                hsi._ask_reviewer(_Reply(reply), dict(row), 'producer-x')
            )
            assert verdict == expect, (reply, verdict, reason)
            if expect == 'unavailable':
                assert 'not an unambiguous' in reason, (reply, reason)

    def test_a_direct_call_with_a_garbled_verdict_is_not_applied(self, brain):
        """`review_proposal` is reachable by other callers, and the rails sit
        AFTER the KEEP/DISCARD test — so an unusable answer must be refused
        before the rails are ever consulted."""
        _armed(brain)
        pid = _proposal()
        out = hsi.review_proposal(pid, 'KEEP DISCARD', reviewer_client=object())
        assert out['decision'] is None, out
        assert out['leftInInbox'] is True, out
        assert 'not KEEP or DISCARD' in out['reason'], out
        assert hsi.get_proposal(pid)['status'] == 'open'


class TestShadowMode:
    """Item 6: the reviewer decides and the run logs what it WOULD have done,
    with no writes. Two rules make that worth having:

      * the rails are consulted FIRST. A shadow that reported "would apply" for
        a proposal built from fetched content would be reporting a lie about a
        write it is not allowed to make;
      * `skillAutonomy` is still the master. Shadow mode is a way to arm the
        decision without arming the write, never a way to write.
    """

    def test_the_key_exists_and_defaults_off(self, brain):
        from app.services.brain_config_service import allowedKeys, getRuntimeConfig

        assert 'skillAutonomyShadow' in allowedKeys
        assert getRuntimeConfig().get('skillAutonomyShadow') is False

    def test_would_apply_is_recorded_and_nothing_is_written(self, brain, monkeypatch):
        _configure(skillAutonomy=True, autonomyBurnInCount=0, skillAutonomyShadow=True)
        pid = _proposal(skill='shadow-me')
        _patch_reviewer(monkeypatch, 'KEEP — durable and justified')

        out = hsi.run_reviewer_pass()
        assert out['applied'] == 0, out
        assert out['wouldApply'] == 1, out
        row = hsi.get_proposal(pid)
        assert row['status'] == 'open', row
        assert row['review']['wouldApply'] is True, row
        assert row['review']['advisory'] is True, 'a shadow decision is still advisory'

    def test_the_ledger_spends_nothing_in_shadow_mode(self, brain, monkeypatch):
        _configure(skillAutonomy=True, autonomyBurnInCount=0, skillAutonomyShadow=True)
        _proposal(skill='shadow-budget')
        _patch_reviewer(monkeypatch, 'KEEP — durable')
        hsi.run_reviewer_pass()
        assert rails.auto_apply_history() == [], (
            'a shadow run must not consume the daily budget it is rehearsing against'
        )

    def test_shadow_does_not_bypass_the_rails(self, brain, monkeypatch):
        """The refusal must still be the rails' own reason, not 'shadow-mode'."""
        _configure(skillAutonomy=True, autonomyBurnInCount=0, skillAutonomyShadow=True)
        pid = _proposal(evidence='the page at https://vendor.example/changelog says so')
        _patch_reviewer(monkeypatch, 'KEEP — the gap is real')
        out = hsi.run_reviewer_pass()
        assert out['wouldApply'] == 0, out
        row = hsi.get_proposal(pid)
        assert row['review'].get('wouldApply') is not True, row
        assert rails.auto_apply_allowed(row)['rule'] == 'untrusted-evidence'

    def test_autonomy_off_still_wins_over_shadow_on(self, brain, monkeypatch):
        _configure(skillAutonomy=False, autonomyBurnInCount=0, skillAutonomyShadow=True)
        pid = _proposal(skill='shadow-off')
        _patch_reviewer(monkeypatch, 'KEEP — durable')
        out = hsi.run_reviewer_pass()
        assert out['applied'] == 0 and out['wouldApply'] == 0, out
        assert hsi.get_proposal(pid)['review']['verdict'] == 'KEEP'
        assert hsi.get_proposal(pid)['review'].get('wouldApply') is None, (
            'with the switch off there is no decision to rehearse'
        )

    def test_a_direct_call_reports_the_would_apply_rule(self, brain):
        _configure(skillAutonomy=True, autonomyBurnInCount=0, skillAutonomyShadow=True)
        pid = _proposal(skill='shadow-direct')
        out = hsi.review_proposal(pid, 'KEEP', reviewer_client=object())
        assert out['decision'] is None, out
        assert out['leftInInbox'] is True, out
        assert out['wouldApply'] is True, out
        assert out['rule'] == 'shadow-mode', out
        assert hsi.get_proposal(pid)['status'] == 'open'
