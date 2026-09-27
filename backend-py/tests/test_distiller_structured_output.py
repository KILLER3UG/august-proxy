"""P2#16 — structured-output judge.

The judge used to advertise ONE flat verdict shape with every field optional
("omit fields irrelevant to the chosen action") and rely on `apply_verdict`
to notice a missing field when it reached a branch that happened to care.
These cover the layer in front of that: per-action schemas, one repair retry,
drop-never-half-apply, and per-action precision bars.
"""

from __future__ import annotations

import pytest
from app.services import skill_distiller as sd

# Reuse the distiller's own brain/proposals fixtures rather than restating
# them: a second copy of an isolation fixture is a second chance for the two
# to drift, and the proposals-dir assertion inside `noProposals` is worth
# having in these tests too.
from tests.test_distiller import brain, noProposals  # noqa: F401


class TestParseVerdicts:
    def test_well_formed_verdicts_pass_through_untouched(self):
        """The layer VALIDATES; it must not rewrite what the judge sent.

        `episode` in particular has to survive verbatim: `run_distiller_pass`
        feeds it straight to `set_judge_verdict(int(epId))`, and the applier
        is called directly by other tests with hand-built dicts. A layer that
        normalised its input would be a second definition of the same shape.
        """
        verdict = {
            'episode': 7,
            'action': 'memory',
            'summary': 'Run pnpm before vitest.',
            'title': 'pnpm first',
            'expires_days': 90,
        }
        applicable, dropped = sd.parse_verdicts({'verdicts': [verdict]})
        assert dropped == []
        assert applicable == [verdict]
        assert applicable[0]['episode'] == 7
        assert isinstance(applicable[0]['episode'], int)

    def test_string_episode_is_also_accepted(self):
        """Real judges send `"3"` as often as `3`; both are usable verdicts."""
        applicable, dropped = sd.parse_verdicts(
            {'verdicts': [{'episode': '3', 'action': 'memory', 'summary': 'x'}]}
        )
        assert dropped == []
        assert applicable[0]['episode'] == '3'

    def test_none_needs_nothing_but_an_episode(self):
        applicable, dropped = sd.parse_verdicts({'verdicts': [{'episode': 1, 'action': 'none'}]})
        assert applicable and not dropped

    def test_missing_required_field_is_dropped_with_a_reason(self):
        applicable, dropped = sd.parse_verdicts(
            {'verdicts': [{'episode': 2, 'action': 'amend_body', 'skill': 'x'}]}
        )
        assert applicable == []
        assert len(dropped) == 1
        assert 'patch_markdown' in dropped[0]['why']
        assert dropped[0]['action'] == 'amend_body'

    def test_empty_string_is_missing_in_disguise(self):
        """An empty `patch_markdown` is not a patch. Requiring non-empty is the
        point: a blank one still burns a proposal slot and a human's click."""
        _, dropped = sd.parse_verdicts(
            {
                'verdicts': [
                    {'episode': 3, 'action': 'amend_body', 'skill': 'x', 'patch_markdown': ''}
                ]
            }
        )
        assert len(dropped) == 1

    def test_unknown_action_is_dropped_not_crashed(self):
        applicable, dropped = sd.parse_verdicts(
            {'verdicts': [{'episode': 4, 'action': 'rewrite_everything'}]}
        )
        assert applicable == []
        assert 'rewrite_everything' in dropped[0]['why']

    def test_one_bad_verdict_does_not_cost_the_good_ones(self):
        """Per-verdict, not per-batch: four usable verdicts must survive one
        malformed sibling."""
        payload = {
            'verdicts': [
                {'episode': 1, 'action': 'memory', 'summary': 'a'},
                {'episode': 2, 'action': 'amend_body', 'skill': 'y'},  # no patch
                {'episode': 3, 'action': 'memory', 'summary': 'c'},
                {'episode': 4, 'action': 'none'},
            ]
        }
        applicable, dropped = sd.parse_verdicts(payload)
        assert [v['episode'] for v in applicable] == [1, 3, 4]
        assert len(dropped) == 1

    def test_extra_keys_are_allowed(self):
        """The prompt advertises more fields than one action uses. A model
        volunteering a `reason` is being helpful, not malformed."""
        applicable, dropped = sd.parse_verdicts(
            {'verdicts': [{'episode': 1, 'action': 'memory', 'summary': 'a', 'body_markdown': 'x'}]}
        )
        assert applicable and not dropped

    def test_non_dict_verdict_is_dropped(self):
        applicable, dropped = sd.parse_verdicts({'verdicts': ['nope', 5]})
        assert applicable == []
        assert len(dropped) == 2

    def test_empty_batch_is_not_an_error(self):
        assert sd.parse_verdicts({'verdicts': []}) == ([], [])

    def test_bad_category_does_not_drop_a_usable_fact(self):
        """`category` is a display label, not the payload. The applier defaults
        it, so rejecting a whole verdict over it would throw away a real
        lesson. This test is the reason `category` is typed `str`."""
        applicable, dropped = sd.parse_verdicts(
            {'verdicts': [{'episode': 9, 'action': 'memory', 'summary': 'a', 'category': 'bogus'}]}
        )
        assert applicable and not dropped

    def test_non_numeric_expiry_does_not_drop_a_usable_fact(self):
        """`apply_verdict` ignores an `expires_days` that is not a number.
        The schema must not be stricter than the applier it feeds."""
        applicable, dropped = sd.parse_verdicts(
            {'verdicts': [{'episode': 9, 'action': 'memory', 'summary': 'a', 'expires_days': '90'}]}
        )
        assert applicable and not dropped

    def test_create_skill_without_description_is_kept(self):
        """The applier falls back to `description or name`, so a judge that
        omits the description still produces a good draft today. Requiring it
        in the schema would make the distiller produce less than it does now.
        This test guards that specific regression."""
        applicable, dropped = sd.parse_verdicts(
            {'verdicts': [{'episode': 2, 'action': 'create_skill', 'name': 'my-skill'}]}
        )
        assert applicable and not dropped

    def test_create_skill_without_a_name_is_dropped(self):
        """`name` is the one field with no fallback — `_validateName('')`
        refuses it anyway, so catching it here just names the real problem."""
        applicable, dropped = sd.parse_verdicts(
            {'verdicts': [{'episode': 2, 'action': 'create_skill', 'description': 'x'}]}
        )
        assert applicable == []
        assert 'name' in dropped[0]['why']

    def test_amend_trigger_needs_a_skill_and_a_trigger(self):
        """Both halves ARE the edit; `apply_verdict` has no fallback for either."""
        _, missing_skill = sd.parse_verdicts(
            {'verdicts': [{'episode': 1, 'action': 'amend_trigger', 'trigger': 't'}]}
        )
        assert 'skill' in missing_skill[0]['why']
        _, missing_trigger = sd.parse_verdicts(
            {'verdicts': [{'episode': 1, 'action': 'amend_trigger', 'skill': 's'}]}
        )
        assert 'trigger' in missing_trigger[0]['why']


class TestPrecisionBuckets:
    def test_global_shape_is_unchanged(self, tmp_path, monkeypatch):
        """Back-compat: harnesses that only record (labeled, correct) keep
        working, and `amendBodyEnabled` still answers off the global bar."""
        from app.lib import paths as paths_mod

        monkeypatch.setattr(paths_mod, 'dataPath', lambda *a, **k: tmp_path / 'p.json')
        state = sd.record_precision_run(labeled=30, correct=25)
        assert state['labeled'] == 30
        assert state['correct'] == 25
        assert state['precision'] == 0.8333
        assert state['amendBodyEnabled'] is True

    def test_action_without_samples_inherits_the_global_figure(self, tmp_path, monkeypatch):
        """An install that never recorded a breakdown must not suddenly read
        every action as 0-labeled and locked."""
        from app.lib import paths as paths_mod

        monkeypatch.setattr(paths_mod, 'dataPath', lambda *a, **k: tmp_path / 'p.json')
        state = sd.record_precision_run(labeled=30, correct=25)
        assert set(state['byAction']) == set(sd.VERDICT_MODELS)
        assert state['byAction']['memory']['labeled'] == 30
        assert state['byAction']['memory']['enabled'] is True

    def test_per_action_buckets_are_independent(self, tmp_path, monkeypatch):
        """The reason this exists: a judge that is great at `memory` and bad at
        `amend_body` must be able to unlock one without the other."""
        from app.lib import paths as paths_mod

        monkeypatch.setattr(paths_mod, 'dataPath', lambda *a, **k: tmp_path / 'p.json')
        sd.record_precision_run(
            labeled=60,
            correct=48,
            per_action={
                'memory': {'labeled': 40, 'correct': 38},
                'amend_body': {'labeled': 20, 'correct': 10},  # 0.5 — below the bar
            },
        )
        state = sd.precision_state()
        assert state['byAction']['memory']['enabled'] is True
        assert state['byAction']['amend_body']['enabled'] is False
        assert state['amendBodyEnabled'] is False
        # The global figure is untouched by the breakdown.
        assert state['labeled'] == 60 and state['correct'] == 48

    def test_min_labeled_applies_per_action(self, tmp_path, monkeypatch):
        from app.lib import paths as paths_mod

        monkeypatch.setattr(paths_mod, 'dataPath', lambda *a, **k: tmp_path / 'p.json')
        state = sd.record_precision_run(
            labeled=45,
            correct=44,
            per_action={'amend_body': {'labeled': 10, 'correct': 10}},  # 1.0 but n=10
        )
        assert state['byAction']['amend_body']['precision'] == 1.0
        assert state['byAction']['amend_body']['enabled'] is False  # 10 < 30

    def test_buckets_accumulate_across_runs(self, tmp_path, monkeypatch):
        from app.lib import paths as paths_mod

        monkeypatch.setattr(paths_mod, 'dataPath', lambda *a, **k: tmp_path / 'p.json')
        sd.record_precision_run(15, 13, per_action={'memory': {'labeled': 15, 'correct': 13}})
        state = sd.record_precision_run(15, 13, per_action={'memory': {'labeled': 15, 'correct': 13}})
        assert state['byAction']['memory']['labeled'] == 30
        assert state['byAction']['memory']['correct'] == 26
        assert state['byAction']['memory']['enabled'] is True


class TestRepairPrompt:
    def test_repair_prompt_names_the_failure(self):
        prompt = sd._repair_prompt('ORIGINAL', [{'why': 'invalid amend_body: patch_markdown'}])
        assert 'ORIGINAL' in prompt
        assert 'patch_markdown' in prompt
        assert 'Strict JSON' in prompt

    def test_repair_prompt_bounds_a_long_failure_list(self):
        dropped = [{'why': f'problem {i}'} for i in range(40)]
        prompt = sd._repair_prompt('ORIGINAL', dropped)
        assert 'problem 0' in prompt
        assert 'problem 39' not in prompt


class TestBatchDropsBeforePersistence:
    """The end-to-end guarantee: an invalid verdict is never applied AT ALL.

    Every other test here checks the gate in isolation. These drive the real
    pass, because "dropped" is only a useful word if nothing downstream was
    written — a verdict that is skipped AFTER `apply_verdict` has already
    saved its fact would satisfy every unit test here and still leak.
    """

    @pytest.fixture
    def passHarness(self, monkeypatch, brain):
        """Stub the judge's surroundings; return the recorded apply calls."""
        from app.services import episode_miner

        calls: list[dict] = []

        # `run_distiller_pass` imports these two INSIDE the function from
        # episode_miner, so they are patched at the source module — patching
        # skill_distiller would silently do nothing and the test would pass for
        # the wrong reason.
        monkeypatch.setattr(
            episode_miner,
            'flagged_episodes',
            lambda limit=50: [{'id': i, 'fingerprint_id': f'fp{i}'} for i in (1, 2, 3)],
        )
        monkeypatch.setattr(episode_miner, 'set_judge_verdict', lambda ep, v: None)
        monkeypatch.setattr(sd, '_in_cooldown', lambda: False)
        monkeypatch.setattr(sd, '_cooldown_batch', lambda n: None)
        monkeypatch.setattr(
            sd, 'apply_verdict', lambda v, fp, mode='extract-only', scope='': calls.append(dict(v)) or 'ok'
        )
        monkeypatch.setattr(
            sd,
            '_run_batch',
            lambda batch: {
                'verdicts': [
                    {'episode': 1, 'action': 'memory', 'summary': 'good one'},
                    # amend_body with no patch: unusable, must never be applied
                    {'episode': 2, 'action': 'amend_body', 'skill': 'x'},
                    {'episode': 3, 'action': 'memory', 'summary': 'good two'},
                ]
            },
        )
        return calls

    def test_invalid_verdict_never_reaches_the_applier(self, passHarness):
        result = sd.run_distiller_pass()
        applied = [c.get('episode') for c in passHarness]
        assert applied == [1, 3]  # the amend_body never arrived
        assert result['dropped'] == 1

    def test_the_pass_reports_what_it_dropped(self, passHarness):
        result = sd.run_distiller_pass()
        dropped_rows = [r for r in result['results'] if r.get('label') == 'dropped-invalid']
        assert len(dropped_rows) == 1
        assert dropped_rows[0]['episode'] == 2
        assert 'patch_markdown' in dropped_rows[0]['why']

    def test_denylist_still_runs_before_persistence(self, monkeypatch, brain, noProposals):
        """P2#16 must not have moved the denylist behind the new gate.

        A sensitive draft is still refused by `apply_verdict` itself, and
        nothing is written — the validation layer only ever removes more.
        """
        label = sd.apply_verdict(
            {
                'episode': 2,
                'action': 'create_skill',
                'name': 'med-reminder-skill',
                'description': 'Remind about medication schedules.',
                'body_markdown': 'Track prescription refills.',
            },
            'user-correction:meds',
            mode='full',
        )
        assert label == 'rejected-denylist'
        assert list(noProposals.glob('prop_*.json')) == []
