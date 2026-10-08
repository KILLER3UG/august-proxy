"""Tier-2 judge + distiller.

Plan acceptance (§3.3/§6): JSON contract, all five actions, denylist on
drafts, one-draft-per-(fingerprint, action, target), propose-time
normalization, extract-only downgrade, precision-gated amend_body, judge
failure cooldown (no retry storms).
"""

from __future__ import annotations

import json

import pytest
from app.services import skill_distiller as sd


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


@pytest.fixture()
def noProposals(monkeypatch, tmp_path):
    """Isolated proposals dir (via dataDir) + agent skills dir for drafts."""
    from app.services import harness_self_improve as hsi
    from app.services import skill_service

    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: tmp_path / 'agent-skills')
    # isolatedData (autouse) already redirects settings.dataDir, so
    # _proposals_dir lands in the test tmp dir.
    assert hsi._proposals_dir().is_relative_to(tmp_path)
    yield hsi._proposals_dir()


class TestJsonContract:
    def test_extract_json_accepts_fence(self):
        raw = '```json\n{"verdicts": [{"episode": 1, "action": "none"}]}\n```'
        data = sd._extractJson(raw)
        assert data['verdicts'][0]['action'] == 'none'

    def test_extract_json_rejects_non_json(self):
        with pytest.raises(Exception):
            sd._extractJson('I think episode 1 is fine, no action needed.')

    def test_extract_json_rejects_missing_verdicts(self):
        with pytest.raises(Exception):
            sd._extractJson('{"episode": 1}')


class TestMemoryAction:
    def test_memory_verdict_saves_harness_lesson(self, brain):
        from app.services.memory_store import get_fact

        label = sd.apply_verdict(
            {
                'episode': 1,
                'action': 'memory',
                'summary': 'Run pnpm before vitest in this repo.',
                'category': 'project',
                'title': 'pnpm before vitest',
                'expires_days': 90,
            },
            'user-correction:pnpm',
        )
        assert label == 'memory-saved'
        fact = get_fact('distilled:pnpm-before-vitest')
        assert fact is not None
        assert fact['source'] == 'harness' and fact['kind'] == 'lesson'
        assert fact['expiresAt']  # 90-day expiry stamped

    def test_denylist_refuses_sensitive_draft(self, brain):
        from app.services.memory_store import get_fact

        label = sd.apply_verdict(
            {
                'episode': 2,
                'action': 'memory',
                'summary': 'User takes antidepressant medication daily.',
                'title': 'medication',
            },
            'user-correction:meds',
        )
        assert label == 'rejected-denylist'
        assert get_fact('distilled:medication') is None


class TestSkillActions:
    def test_denylist_covers_skill_draft_text(self, brain, noProposals):
        """The denylist applies to EVERY drafted body — create_skill and
        amend_body payloads used to persist unchecked (memory verdicts only)."""
        label = sd.apply_verdict(
            {
                'episode': 3,
                'action': 'create_skill',
                'name': 'med-reminder-skill',
                'description': 'Remind about medication schedules.',
                'trigger': 'when the user mentions medication',
                'body_markdown': '## How to Run\n\nTrack prescription refills.',
            },
            'user-correction:meds',
            mode='full',
        )
        assert label == 'rejected-denylist'
        assert list(noProposals.glob('prop_*.json')) == []

    def test_denylist_covers_amend_body_patch(self, brain, noProposals, monkeypatch, tmp_path):
        from app.services import skill_service

        skill_dir = tmp_path / 'agent-skills' / 'med-tracker'
        skill_dir.mkdir(parents=True)
        (skill_dir / 'SKILL.md').write_text(
            '---\nname: med-tracker\ndescription: tracker.\n---\n\n## What It Does\n\nTracks tasks.\n',
            encoding='utf-8',
        )
        monkeypatch.setattr(sd, '_learnedSkillText', lambda name: ('tracker.', '## What It Does\n\nTracks tasks.'))
        monkeypatch.setattr(
            skill_service, '_agentSkillsDir', lambda: tmp_path / 'agent-skills'
        )
        label = sd.apply_verdict(
            {
                'episode': 9,
                'action': 'amend_body',
                'skill': 'med-tracker',
                'patch_markdown': '## Notes\n\nUser takes antidepressant medication daily.',
            },
            'user-correction:meds',
            mode='full',
        )
        assert label == 'rejected-denylist'
        assert list(noProposals.glob('prop_*.json')) == []

    def test_create_skill_files_a_full_procedure(self, brain, noProposals):
        label = sd.apply_verdict(
            {
                'episode': 3,
                'action': 'create_skill',
                'name': 'quartus-recovery',
                'description': 'Recover from Quartus compile failures.',
                'trigger': 'when a Quartus fmax parse fails',
                'intro': ['Re-runs the timing report the way this project’s flow expects.'],
                'when_to_use': ['a Quartus fit finishes but fmax parsing fails'],
                'prerequisites': ['quartus_sta on PATH'],
                'steps': [
                    {'do': 'Regenerate the report in batch mode', 'command': 'quartus_sta -s build.sta'},
                    {'do': 'Read the slack from the receipt, not the prose'},
                ],
                'pitfalls': [{'seen': 'quartus_sta printed to a GUI window', 'instead': 'pass -s'}],
                'verification': ['the receipt names one endpoint and its slack'],
            },
            'tool-error:quartus',
            mode='full',
        )
        assert label == 'proposal-filed', label
        proposals = list(noProposals.glob('prop_*.json'))
        assert len(proposals) == 1
        row = json.loads(proposals[0].read_text('utf-8'))
        assert row['kind'] == 'skill_create'
        payload = row['payload']
        assert payload['fingerprint'] == 'tool-error:quartus'
        assert payload['origin'] == 'distilled'
        # The drafted procedure is what ships — verbatim command and all.
        assert 'quartus_sta -s build.sta' in payload['body']
        assert 'pass -s' in payload['body']
        assert '## Procedure' in payload['body']

    def test_a_rule_is_filed_as_a_lesson_not_a_skill(self, brain, noProposals):
        """The complaint this answers: a learned skill that was one sentence
        wearing headings. A draft with no procedure is a RULE, and the memory
        store is where a rule goes — the lesson survives, the costume does not."""
        from app.services.memory_store import get_fact

        label = sd.apply_verdict(
            {
                'episode': 31,
                'action': 'create_skill',
                'name': 'flat-flag',
                'description': 'Always pass --flat=on to the flow.',
                'trigger': 'when the flow is run',
                'body_markdown': '## How to Run\n\nRe-run the flow with --flat=on.',
            },
            'tool-error:flat',
            mode='full',
        )
        assert label == 'memory-saved', label
        assert list(noProposals.glob('prop_*.json')) == []
        fact = get_fact('distilled:flat-flag')
        assert fact is not None
        assert 'Always pass --flat=on' in fact['factValue']
        assert fact['source'] == 'harness'

    def test_amend_trigger_keeps_the_body_it_was_never_asked_to_write(
        self, brain, noProposals, monkeypatch, tmp_path
    ):
        """A trigger patch carries no body. Normalizing the empty one used to
        build description-derived PLACEHOLDER text into payload.body, and
        `_apply_skill_write` writes payload.body OVER the target — so approving
        a trigger change replaced a real skill's procedure with boilerplate."""
        from app.services import harness_self_improve as hsi
        from app.services import skill_service

        root = tmp_path / 'agent-skills' / 'run-sims'
        root.mkdir(parents=True)
        (root / 'SKILL.md').write_text(
            '---\nname: run-sims\ndescription: Run circuit sims.\n---\n'
            '# Run ngspice sims\n\n## When to Use\n\n- a netlist needs a solve\n\n'
            '## Procedure\n\n1. ngspice -b a.cir\n2. read the print table\n\n'
            '## Pitfalls\n\n- the GUI opens without -b\n\n'
            '## Verification\n\n- the receipt has a numeric row\n',
            encoding='utf-8',
        )
        monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: root.parent)
        label = sd.apply_verdict(
            {'episode': 21, 'action': 'amend_trigger', 'skill': 'run-sims',
             'trigger': 'when a netlist must be re-solved'},
            'tool-error:sims-trigger',
            mode='full',
        )
        assert label == 'proposal-filed', label
        body = hsi.list_proposals(status='open')[0]['payload']['body']
        assert 'ngspice -b a.cir' in body
        assert '_None recorded yet' not in body
        assert 'No content yet' not in body

    def test_amend_trigger_against_an_unknown_skill_is_not_filed(
        self, brain, noProposals, monkeypatch, tmp_path
    ):
        from app.services import skill_service

        monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: tmp_path / 'empty-root')
        label = sd.apply_verdict(
            {'episode': 22, 'action': 'amend_trigger', 'skill': 'no-such-skill', 'trigger': 't'},
            'tool-error:ghost-trigger',
            mode='full',
        )
        assert label == 'rejected-unknown-skill'
        assert list(noProposals.glob('prop_*.json')) == []

    def test_the_evidence_window_carries_the_call_that_WORKED(self, brain):
        """`events` holds only failures, so without the tool-call sequence the
        judge cannot see the recovery and can only restate the error — which is
        mechanically why drafts came out as one-line rules."""
        from app.services.memory_store import init

        init()
        conn = sd._conn()
        conn.execute("INSERT OR IGNORE INTO sessions (id, title) VALUES ('s-window', 't')")
        cur = conn.execute(
            'INSERT INTO messages (session_id, role, content, blocks_json) VALUES (?, ?, ?, ?)',
            (
                's-window',
                'assistant',
                'solved it',
                json.dumps({
                    'blocks': [
                        {'id': 'b1', 'type': 'toolCall',
                         'tool': {'name': 'run_command', 'args': '{"command":"ngspice a.cir"}',
                                  'status': 'error'}},
                        {'id': 'b2', 'type': 'toolCall',
                         'tool': {'name': 'run_command', 'args': '{"command":"ngspice -b a.cir"}',
                                  'status': 'done'}},
                    ]
                }),
            ),
        )
        msgId = int(cur.lastrowid)
        window = sd._episodeWindow({
            'id': 7, 'kind': 'failure_recovery', 'outcome': 'resolved',
            'events': [{'type': 'tool_error', 'excerpt': 'run_command: GUI opened'}],
            'session_id': 's-window', 'start_message_id': msgId, 'end_message_id': msgId,
        })
        assert 'ngspice -b a.cir' in window  # the fix, verbatim
        assert '-> done' in window
        assert 'tool_error: run_command: GUI opened' in window

    def test_a_proposal_carries_the_episode_that_justified_it(self, brain, noProposals):
        """Reviewers approve a drafted body; the evidence line used to render
        empty because it read a key the judge never sends."""
        from app.services import episode_miner as em

        sd._conn().execute("INSERT OR IGNORE INTO sessions (id, title) VALUES ('s-ev', 't')")
        first = sd._conn().execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            ('s-ev', 'tool', 'run_command: GUI opened'),
        ).lastrowid
        epId = em.save_episode({
            'session_id': 's-ev', 'kind': 'failure_recovery', 'outcome': 'resolved',
            'start_message_id': int(first), 'end_message_id': int(first),
            'events': [{'type': 'tool_error', 'excerpt': 'run_command: GUI opened'}],
            'fingerprint_id': 'tool-error:evidence',
        })
        label = sd.apply_verdict(
            {'episode': epId, 'action': 'create_skill', 'name': 'evidence-skill',
             'description': 'Read the receipt.',
             'when_to_use': ['a tool reports success with no output'],
             'steps': [{'do': 'read the receipt', 'command': 'run_command(command="ngspice -b a.cir")'},
                       {'do': 'compare it to the prose'}],
             'pitfalls': [{'seen': 'prose lied', 'instead': 'the receipt does not'}],
             'verification': ['the two agree']},
            'tool-error:evidence',
            mode='full',
        )
        assert label == 'proposal-filed', label
        proposals = list(noProposals.glob('prop_*.json'))
        row = json.loads(proposals[0].read_text('utf-8'))
        assert 'tool_error' in row['evidence']
        assert 'GUI opened' in row['evidence']

    def test_the_window_survives_an_episode_with_no_transcript(self, brain):
        """`apply_verdict` builds evidence from a hand-made dict with no session
        or message range at all — the timeline read must not become a crash."""
        window = sd._episodeWindow({'id': 8, 'kind': '', 'outcome': '', 'events': []})
        assert 'episode 8' in window

    def test_a_draft_with_no_body_at_all_is_not_padded_into_a_skill(self, brain, noProposals):
        label = sd.apply_verdict(
            {
                'episode': 32,
                'action': 'create_skill',
                'name': 'empty-draft',
                'description': 'Something about the flow.',
            },
            'tool-error:empty',
            mode='full',
        )
        assert label == 'memory-saved', label
        assert list(noProposals.glob('prop_*.json')) == []

    def test_a_long_description_is_cut_to_the_cap_so_approval_works(self, brain, noProposals):
        """`_apply_skill_write` re-validates the description on APPROVAL, so a
        drafted one over 60 chars filed a proposal the human could not approve."""
        label = sd.apply_verdict(
            {
                'episode': 33,
                'action': 'create_skill',
                'name': 'long-desc-skill',
                'description': (
                    'Recover from a Quartus compile failure by re-running the timing report '
                    'in batch mode and reading the slack from the receipt table.'
                ),
                'when_to_use': ['a fit finishes and the fmax parse fails'],
                'steps': [
                    {'do': 'Regenerate the report', 'command': 'quartus_sta -s build.sta'},
                    {'do': 'Read the slack from the receipt'},
                ],
                'pitfalls': [{'seen': 'the GUI swallows the output', 'instead': 'pass -s'}],
                'verification': ['one endpoint named with its slack'],
            },
            'tool-error:longdesc',
            mode='full',
        )
        assert label == 'proposal-filed', label
        row = json.loads(list(noProposals.glob('prop_*.json'))[0].read_text('utf-8'))
        desc = row['payload']['description']
        assert len(desc) <= 60
        from app.services.skill_service import _validateDescription

        _validateDescription(desc)  # would raise on an unapprovable draft

    def test_an_approved_draft_lands_on_disk_as_a_procedure_not_a_rule(
        self, brain, noProposals, monkeypatch, tmp_path
    ):
        """The whole point, end to end: file → approve → the bytes a later turn
        reads with `load_skill`. Pins that the drafted steps survive to the file
        and that no normalizer boilerplate reaches it."""
        from app.services import harness_self_improve as hsi
        from app.services import skill_service

        root = tmp_path / 'agent-skills'
        monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: root)
        monkeypatch.setattr(skill_service, '_ensureAgentRoot', lambda: root)
        label = sd.apply_verdict(
            {
                'episode': 41,
                'action': 'create_skill',
                'name': 'ngspice-batch-sim',
                'description': 'Run ngspice netlists headlessly.',
                'trigger': 'when a netlist must be re-solved',
                'title': 'ngspice batch simulation',
                'intro': ['Runs a netlist and reads the measurement back.',
                          'It does not flash hardware.'],
                'when_to_use': ['the user asks to simulate a circuit'],
                'when_not_to_use': ['the user wants an FPGA build'],
                'prerequisites': ['ngspice on PATH'],
                'steps': [
                    {'do': 'Run in batch mode', 'command': 'run_command(command="ngspice -b a.cir")'},
                    {'do': 'Read the print table from the receipt, not the prose'},
                ],
                'pitfalls': [{'seen': 'ngspice opened a GUI and hung the turn',
                              'instead': 'always pass -b'}],
                'verification': ['the receipt holds a numeric row'],
                'keywords': ['simulate', 'netlist', 'ngspice'],
            },
            'tool-error:ondisk',
            mode='full',
        )
        assert label == 'proposal-filed', label
        props = hsi.list_proposals(status='open')
        res = hsi.decide_proposal(props[0]['id'], 'approve')
        assert res.get('applyResult', {}).get('ok') is True, res

        text = (root / 'ngspice-batch-sim' / 'SKILL.md').read_text('utf-8')
        # Frontmatter: the id, the capability, when it fires, and its tags.
        assert 'name: ngspice-batch-sim' in text
        # Quoted, as the emitter writes it — a description containing a colon
        # would otherwise parse as a nested key.
        assert 'description: "Run ngspice netlists headlessly."' in text
        assert 'trigger: when a netlist must be re-solved' in text
        assert 'ngspice' in text.split('---')[1]  # keywords carried through
        # Body: the author's title, the verbatim command, the real pitfall.
        assert text.startswith('---')
        assert '# ngspice batch simulation' in text
        assert 'ngspice -b a.cir' in text
        assert 'Instead: always pass -b' in text
        assert 'Do not use it when:' in text
        # And nothing the normalizer invented.
        for boilerplate in ('_None recorded yet', 'No content yet', 'fill in any tools'):
            assert boilerplate not in text, boilerplate


    def test_the_denylist_scans_the_section_fields(self, brain, noProposals):
        """A health detail in `pitfalls` used to walk past a gate that only read
        description/body_markdown/trigger/patch_markdown."""
        label = sd.apply_verdict(
            {
                'episode': 34,
                'action': 'create_skill',
                'name': 'med-schedule-helper',
                'description': 'Track the refill schedule.',
                'pitfalls': [
                    {'seen': 'User takes antidepressant medication daily', 'instead': 'ask'}
                ],
                'steps': [{'do': 'a', 'command': 'b'}, {'do': 'c'}],
            },
            'tool-error:meds',
            mode='full',
        )
        assert label == 'rejected-denylist'
        assert list(noProposals.glob('prop_*.json')) == []

    def test_one_draft_per_fingerprint_action_target(self, brain, noProposals):
        verdict = {
            'episode': 4,
            'action': 'create_skill',
            'name': 'dup-draft',
            'description': 'Recover from X.',
            'when_to_use': ['when X fails'],
            'steps': [{'do': 'run it', 'command': 'x --flag'}, {'do': 'read the receipt'}],
            'pitfalls': [{'seen': 'x hangs', 'instead': 'pass --flag'}],
            'verification': ['a row in the receipt'],
        }
        assert sd.apply_verdict(verdict, 'tool-error:dup', mode='full') == 'proposal-filed'
        assert sd.apply_verdict({**verdict, 'episode': 5}, 'tool-error:dup', mode='full') == 'duplicate-draft'
        assert len(list(noProposals.glob('prop_*.json'))) == 1

    def test_extract_only_skips_skill_drafting(self, brain, noProposals):
        label = sd.apply_verdict(
            {'episode': 6, 'action': 'create_skill', 'name': 'extract-only-skill', 'description': 'd'},
            'tool-error:eo',
            mode='extract-only',
        )
        assert label == 'skipped-extract-only'
        assert not list(noProposals.glob('prop_*.json'))

    def test_amend_body_downgrades_below_precision_bar(self, brain, noProposals):
        label = sd.apply_verdict(
            {
                'episode': 7,
                'action': 'amend_body',
                'skill': 'existing-skill',
                'patch_markdown': '## Pitfalls\n\nnew pitfall',
            },
            'tool-error:amend',
            mode='full',
        )
        assert label == 'downgraded-proposal'
        proposals = [json.loads(p.read_text('utf-8')) for p in noProposals.glob('prop_*.json')]
        assert len(proposals) == 1
        # 2026-09-02: the downgrade observation files under its OWN dedupe key
        # ('amend_body_downgrade') so it can never consume the genuine
        # (fp, 'amend_trigger', skill) key a later real amend verdict needs.
        assert proposals[0]['payload']['action'] == 'amend_body_downgrade'
        assert 'precision' in proposals[0]['payload']['note']

    def test_amend_body_gated_on_precision_state(self, brain, monkeypatch, tmp_path):
        monkeypatch.setattr(
            sd, 'precision_state', lambda: {'labeled': 30, 'correct': 25, 'precision': 0.8333, 'amendBodyEnabled': True}
        )
        assert sd.precision_state()['amendBodyEnabled'] is True
        monkeypatch.setattr(
            sd, 'precision_state', lambda: {'labeled': 10, 'correct': 9, 'precision': 0.9, 'amendBodyEnabled': False}
        )
        assert sd.precision_state()['amendBodyEnabled'] is False


class TestAmendBodyEnabledPath:
    """Once the precision ship bar is MET, amend_body files a REAL skill_patch
    (human-approved, never auto-applied). The judge never sees skill bodies,
    so the patch is APPENDED to the current body — approval must preserve
    every line that was already there (audit finding 4: the enabled branch
    was a stub returning 'amend_body-not-enabled-v1')."""

    @pytest.fixture()
    def learnedSkill(self, monkeypatch, tmp_path):
        from app.services import skill_service

        root = tmp_path / 'agent-skills'
        root.mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: root)
        (root / 'run-sims').mkdir()
        (root / 'run-sims' / 'SKILL.md').write_text(
            '---\nname: run-sims\ndescription: Run circuit sims.\n---\n'
            '# What this skill is\n\nRun ngspice sims.\n\n## How to Run\n\n1. ngspice -b a.cir\n',
            'utf-8',
        )
        return root

    def test_bar_met_files_real_patch_appending_to_body(self, brain, monkeypatch, tmp_path, learnedSkill):
        from app.services import harness_self_improve as hsi

        monkeypatch.setattr(
            sd,
            'precision_state',
            lambda: {'labeled': 30, 'correct': 25, 'precision': 0.8333, 'amendBodyEnabled': True},
        )
        label = sd.apply_verdict(
            {
                'episode': 9,
                'action': 'amend_body',
                'skill': 'run-sims',
                'patch_markdown': '## Pitfalls\n\nAlways pass -b or ngspice opens the GUI.',
            },
            'tool-error:sims',
            mode='full',
        )
        assert label == 'patch-proposal-filed', label
        props = hsi.list_proposals(status='open')
        assert len(props) == 1 and props[0]['kind'] == 'skill_patch'
        payload = props[0]['payload']
        assert payload['action'] == 'amend_body' and payload['target'] == 'run-sims'
        # The merged body carries the CURRENT prose plus the amendment.
        assert 'Run ngspice sims.' in payload['body']
        assert '## Pitfalls' in payload['body']

    def test_bar_met_approval_writes_merged_body_to_disk(self, brain, monkeypatch, tmp_path, learnedSkill):
        from app.services import harness_self_improve as hsi

        monkeypatch.setattr(
            sd,
            'precision_state',
            lambda: {'labeled': 30, 'correct': 25, 'precision': 0.8333, 'amendBodyEnabled': True},
        )
        sd.apply_verdict(
            {
                'episode': 9,
                'action': 'amend_body',
                'skill': 'run-sims',
                'patch_markdown': '## Pitfalls\n\nAlways pass -b.',
            },
            'tool-error:sims2',
            mode='full',
        )
        props = hsi.list_proposals(status='open')
        res = hsi.decide_proposal(props[0]['id'], 'approve')
        assert res.get('applyResult', {}).get('ok') is True
        on_disk = (learnedSkill / 'run-sims' / 'SKILL.md').read_text('utf-8')
        # Nothing lost: the original prose survives the amendment.
        assert 'Run ngspice sims.' in on_disk
        assert 'Always pass -b.' in on_disk
        assert '## Pitfalls' in on_disk

    def test_bar_met_bundled_target_becomes_revised_draft(self, brain, monkeypatch, tmp_path):
        from app.services import harness_self_improve as hsi
        from app.services import skill_service

        monkeypatch.setattr(
            sd,
            'precision_state',
            lambda: {'labeled': 30, 'correct': 25, 'precision': 0.8333, 'amendBodyEnabled': True},
        )
        # A REAL bundled file: a `-revised` draft has to carry the text it
        # supersedes, so the path needs something to read.
        bundled = tmp_path / 'bundled' / 'august-tools'
        bundled.mkdir(parents=True)
        (bundled / 'SKILL.md').write_text(
            '---\nname: august-tools\ndescription: Rules for the tool surface.\n'
            '---\n\n# August Tools — Usage Rules\n\n'
            '## When to Use\n\n- a tool call is about to be made\n\n'
            '## Procedure\n\n1. check the gate\n2. run the tool\n\n'
            '## Pitfalls\n\n- bulk is unguarded at the alias\n\n'
            '## Verification\n\n- the receipt exit code is zero\n',
            encoding='utf-8',
        )
        monkeypatch.setattr(skill_service, 'SKILLS_DIR', tmp_path / 'bundled')
        monkeypatch.setattr(sd, '_isBundledSkill', lambda name: name == 'august-tools')
        label = sd.apply_verdict(
            {
                'episode': 11,
                'action': 'amend_body',
                'skill': 'august-tools',
                'patch_markdown': '## Pitfalls\n\nWatch the budget.',
            },
            'tool-error:bundled',
            mode='full',
        )
        assert label == 'proposal-filed', label
        props = hsi.list_proposals(status='open')
        assert len(props) == 1 and props[0]['kind'] == 'skill_create'
        assert props[0]['payload']['name'] == 'august-tools-revised'
        assert props[0]['payload']['supersedes'] == 'august-tools'
        # The revision contains the original prose AND the amendment — a draft
        # that superseded a real skill with placeholder text was the old bug.
        assert 'bulk is unguarded at the alias' in props[0]['payload']['body']
        assert 'Watch the budget.' in props[0]['payload']['body']

    def test_bundled_target_without_a_readable_skill_is_not_filed(
        self, brain, monkeypatch, tmp_path
    ):
        from app.services import harness_self_improve as hsi
        from app.services import skill_service

        monkeypatch.setattr(
            sd,
            'precision_state',
            lambda: {'labeled': 30, 'correct': 25, 'precision': 0.8333, 'amendBodyEnabled': True},
        )
        monkeypatch.setattr(skill_service, 'SKILLS_DIR', tmp_path / 'nothing-here')
        monkeypatch.setattr(sd, '_isBundledSkill', lambda name: name == 'ghost-skill')
        label = sd.apply_verdict(
            {'episode': 12, 'action': 'amend_body', 'skill': 'ghost-skill',
             'patch_markdown': '## Pitfalls\n\nx'},
            'tool-error:ghost',
            mode='full',
        )
        assert label == 'amend_body-target-missing'
        assert hsi.list_proposals(status='open') == []

    def test_bar_met_missing_target_is_not_filed(self, brain, monkeypatch, tmp_path, learnedSkill):
        monkeypatch.setattr(
            sd,
            'precision_state',
            lambda: {'labeled': 30, 'correct': 25, 'precision': 0.8333, 'amendBodyEnabled': True},
        )
        label = sd.apply_verdict(
            {'episode': 12, 'action': 'amend_body', 'skill': 'no-such-skill', 'patch_markdown': 'x'},
            'tool-error:missing',
            mode='full',
        )
        assert label == 'amend_body-target-missing'


class TestFitDescription:
    """The cap is enforced at APPROVAL by `_apply_skill_write`, so a drafted
    description that ran long filed a proposal a human could not approve."""

    def test_a_valid_description_passes_through_untouched(self):
        assert sd._fitDescription('Read the tool receipt, not the prose.') == (
            'Read the tool receipt, not the prose.',
            '',
        )

    def test_a_long_one_is_cut_at_a_clause_with_exactly_one_period(self):
        long = (
            'Recover from a Quartus compile failure, by re-running the report, '
            'and reading the slack table back.'
        )
        fitted, problem = sd._fitDescription(long)
        assert problem == ''
        assert len(fitted) <= 60
        assert fitted.endswith('.')
        assert not fitted.endswith('..')
        # The comma clause wins over a bare word boundary: the separator list is
        # tried sentence-end, clause, then space.
        assert fitted == 'Recover from a Quartus compile failure.'

    def test_a_marketing_claim_is_reported_not_rewritten(self):
        """Length is a typo; a banned word is a claim. Rewriting the operator's
        sentence to get past a validator would be the gate editing the work."""
        fitted, problem = sd._fitDescription('A powerful way to read receipts.')
        assert fitted == ''
        assert 'powerful' in problem


class TestJudgeFailureCooldown:
    def test_cooldown_skips_pass(self, brain, monkeypatch):
        from datetime import datetime, timedelta, timezone

        from app.services.memory_store import set_internal_state

        set_internal_state('skill_distiller_judge_cooldown', (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat())
        out = sd.run_distiller_pass()
        assert out.get('skipped') == 'judge cooldown'


class TestModelResolution:
    def test_explicit_setting_wins(self, monkeypatch):
        from app.services.brain_config_service import saveBrainConfig

        monkeypatch.setattr(sd, '_resolveProvider', lambda m: {'name': m} if m else None)
        saveBrainConfig({'skillLearningJudgeModel': 'judge-model-x', 'titleModel': 'title-model-y'})
        try:
            assert sd.resolve_judge_model() == 'judge-model-x'
        finally:
            saveBrainConfig({'skillLearningJudgeModel': ''})

    def test_no_model_resolves_to_empty(self, monkeypatch):
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({'skillLearningJudgeModel': '', 'titleModel': ''})
        monkeypatch.setattr(sd, '_resolveProvider', lambda m: {'name': m} if m else None)
        assert sd.resolve_judge_model() in ('', 'auto-memory-model-x')

    def test_the_fleet_hippocampus_role_is_a_judge_fallback(self, monkeypatch):
        """The distiller piggybacks the consolidation cadence and distills the
        memory store, so the memory model is the semantically right fallback —
        without it, an install that configured only the fleet never gets judged.
        Resolved through `resolveRoleModel`, so the role's gateway travels with
        its model id."""
        from app.services.brain_config_service import saveBrainConfig
        from app.services.model_fleet_service import updateFleet

        saveBrainConfig({'skillLearningJudgeModel': '', 'autoMemoryModel': '', 'titleModel': ''})
        updateFleet({'models': {'hippocampus': 'fleet-mem-model'}, 'providers': {'hippocampus': 'gate-mem'}})
        monkeypatch.setattr(sd, '_resolveProvider', lambda m, hint='': {'id': m} if m else None)
        assert sd.resolve_judge() == ('fleet-mem-model', 'gate-mem')

    def test_judge_status_says_why_the_loop_is_idle(self, brain, monkeypatch):
        """Twelve episodes sat flagged for tier 2 with nothing written about
        why. An unresolvable judge is not an error, so no lifecycle row existed
        — this read is what the Learning panel renders instead."""
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({'skillLearningJudgeModel': '', 'autoMemoryModel': '', 'titleModel': ''})
        monkeypatch.setattr(sd, '_resolveProvider', lambda m, hint='': None)
        status = sd.judgeStatus()
        assert status['state'] == 'unconfigured'
        assert 'no judge model resolves' in status['reason'].lower()
        assert status['pendingEpisodes'] == 0
        assert 'Set "Judge model"' in status['reason']

    def test_judge_status_counts_the_episodes_still_waiting(self, brain, monkeypatch):
        from app.services import episode_miner as em
        from app.services.brain_config_service import saveBrainConfig

        sd._conn().execute("INSERT OR IGNORE INTO sessions (id, title) VALUES ('js-1', 't')")
        first = int(
            sd._conn().execute(
                'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
                ('js-1', 'tool', 'run_command: boom'),
            ).lastrowid
        )
        epId = em.save_episode({
            'session_id': 'js-1', 'kind': 'failure_recovery', 'outcome': 'unresolved',
            'start_message_id': first, 'end_message_id': first,
            'events': [{'type': 'tool_error', 'excerpt': 'run_command: boom'}],
            'fingerprint_id': 'tool-error:status',
        })
        sd._conn().execute('UPDATE episodes SET tier = 2 WHERE id = ?', (epId,))
        sd._conn().commit()
        saveBrainConfig({'skillLearningJudgeModel': '', 'autoMemoryModel': '', 'titleModel': ''})
        monkeypatch.setattr(sd, '_resolveProvider', lambda m, hint='': None)
        assert sd.judgeStatus()['pendingEpisodes'] == 1

        em.set_judge_verdict(epId, '{"action": "none"}')
        assert sd.judgeStatus()['pendingEpisodes'] == 0

    def test_judge_status_reports_a_model_no_gateway_serves(self, brain, monkeypatch):
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({'skillLearningJudgeModel': 'ghost-model-x'})
        monkeypatch.setattr(sd, '_resolveProvider', lambda m, hint='': None)
        status = sd.judgeStatus()
        assert status['state'] == 'no-provider'
        assert 'ghost-model-x' in status['reason']

    def test_judge_status_is_ready_when_a_provider_resolves(self, brain, monkeypatch):
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({'skillLearningJudgeModel': 'real-model-x'})
        monkeypatch.setattr(sd, '_resolveProvider', lambda m, hint='': {'id': m} if m else None)
        status = sd.judgeStatus()
        assert status['state'] == 'ready'
        assert status['reason'] == ''
        assert status['model'] == 'real-model-x'
        saveBrainConfig({'skillLearningJudgeModel': ''})




class TestJudgeFailureNamesItsCause:
    """Measured on the real install: 13 `distiller_judge_failed` lifecycle rows,
    every one with detail shaped exactly `{"batchSize": N, "cooldownUntil": …}`.
    The reason was logged as a warning and dropped from the record, which is why
    a month of failing passes stayed undiagnosable."""

    def _rows(self):
        from app.services.memory_conn import conn

        return [
            dict(r)
            for r in conn().execute("SELECT event_type, detail FROM lifecycle WHERE event_type LIKE 'distiller_judge%'")
        ]

    def test_an_unparseable_response_records_the_reason(self, brain, monkeypatch):
        import asyncio

        # The real shape: the provider answers with an empty body, so the JSON
        # parse raises and the call used to collapse into a bare None.
        class EmptyClient:
            config = {}

            async def generate(self, prompt, system=None):
                return ''

            async def close(self):
                pass

        monkeypatch.setattr(sd, 'resolve_judge', lambda: ('some-model', ''))
        monkeypatch.setattr(sd, '_resolveProvider', lambda m, hint='': {'id': 'p'})
        monkeypatch.setattr('app.providers.clients.getUnpooledClient', lambda p: EmptyClient())
        assert asyncio.run(sd.call_judge('anything')) is None
        assert sd.take_judge_failure()[0] == 'unparseable-response'

    def test_the_cooldown_row_carries_the_reason(self, brain, monkeypatch):
        from app.services.memory_store import init

        init()
        monkeypatch.setattr(sd, 'take_judge_failure', lambda: ('timeout', 'judge exceeded 90s'))
        sd._cooldown_batch(5)
        row = self._rows()[-1]
        import json

        detail = json.loads(str(row['detail']))
        assert detail['reason'] == 'timeout'
        assert 'judge exceeded 90s' in detail['error']
        assert detail['batchSize'] == 5

    def test_a_missing_judge_model_is_not_recorded_as_a_transient_failure(
        self, brain, monkeypatch
    ):
        """A misconfiguration is permanent and needs a human. Cooling down for 30
        minutes and labelling it "judge failed" hides it among real failures —
        which is exactly how this install spent 13 passes on a fake model name
        written into its config by a test."""
        from app.services.memory_store import init

        init()
        monkeypatch.setattr(sd, 'resolve_judge', lambda: ('', ''))
        import asyncio

        assert asyncio.run(sd.call_judge('anything')) is None
        assert sd.take_judge_failure()[0] == 'no-judge-model'
        import asyncio

        assert asyncio.run(sd.call_judge('anything')) is None
        # The pass's failure handler is what decides between the two kinds.
        sd._cooldown_batch(5)
        rows = self._rows()
        kinds = [r['event_type'] for r in rows]
        assert 'distiller_judge_unavailable' in kinds, rows
        assert 'distiller_judge_failed' not in kinds
        # And no 30-minute cooldown was armed: a human has to fix the config,
        # so retrying on a timer would just fail again quietly.
        from app.services.memory_store import get_internal_state

        assert not str(get_internal_state(sd._cooldownKey()) or '')
