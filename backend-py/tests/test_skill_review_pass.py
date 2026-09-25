"""The LLM skill-review pass (consolidation's read across the whole library).

Skills accumulate one at a time and nothing ever looked at the set as a whole.
This pass does, once per consolidation cadence. What is pinned:

  1. a finding about a real skill becomes a proposal — and never edits SKILL.md
  2. only `delete`/`stale` become an APPROVABLE skill_delete; everything else is
     an observation, because a skill_patch whose payload cannot be applied would
     surface an approve button that fails
  3. an invented skill name is refused
  4. a skill with a pending proposal is not proposed at again
  5. no model / a one-skill library means no findings, not an error
"""

from __future__ import annotations

import json

import pytest
from app.services import skill_service
from app.services.memory_store import consolidation as cons


@pytest.fixture
def library(tmp_path, monkeypatch):
    """Two real agent skills written into the agent root. The autouse
    ``isolatedData`` fixture already points the data dir at a temp path, and the
    bundled repo root stays in the catalogue — the assertions below are about
    these two names, not about the list's size."""
    root = tmp_path / 'agent-skills'
    monkeypatch.setattr('app.services.skill_service._agentSkillsDir', lambda: root)
    for name, desc in (
        ('pdf-tools', 'Extract text and tables from PDF files.'),
        ('pdf-extract', 'Read text out of a PDF document.'),
    ):
        d = root / name
        d.mkdir(parents=True)
        (d / 'SKILL.md').write_text(
            f'---\nname: {name}\ndescription: {desc}\ncategory: development\n---\n\n# {name}\n\nBody.\n',
            'utf-8',
        )
    return root


def _stub(monkeypatch, reply: str):
    calls = []
    monkeypatch.setattr(
        cons, '_model_complete', lambda system, user: calls.append(user) or reply
    )
    return calls


def _pending() -> list[dict]:
    """Harness proposal files spell an undecided row ``status: 'open'``."""
    from app.services.harness_self_improve import list_proposals

    return list_proposals(status='open')


def test_catalogue_reads_the_real_library(library):
    names = {s['name'] for s in cons._skill_catalogue()}
    assert {'pdf-tools', 'pdf-extract'} <= names


def test_a_delete_finding_becomes_an_approvable_proposal(library, monkeypatch):
    _stub(
        monkeypatch,
        json.dumps(
            [
                {
                    'name': 'pdf-extract',
                    'kind': 'delete',
                    'summary': 'Duplicates pdf-tools.',
                    'action': 'Remove it.',
                }
            ]
        ),
    )
    before = (library / 'pdf-extract' / 'SKILL.md').read_text('utf-8')
    filed, notes = cons._skill_review_pass()
    assert filed == 1
    assert notes and 'pdf-extract' in notes[0]
    rows = [r for r in _pending() if r.get('kind') == 'skill_delete']
    assert rows and rows[0]['payload']['name'] == 'pdf-extract'
    # Propose-only: the file is byte-identical until a human approves.
    assert (library / 'pdf-extract' / 'SKILL.md').read_text('utf-8') == before


def test_an_overlap_finding_is_an_observation_not_a_broken_patch(library, monkeypatch):
    """skill_patch approval writes a whole SKILL.md from the proposal. A review
    verdict has no such body, so filing it as skill_patch would put a failing
    approve button in the inbox."""
    _stub(
        monkeypatch,
        json.dumps(
            [
                {
                    'name': 'pdf-tools',
                    'kind': 'overlap',
                    'summary': 'Overlaps pdf-extract.',
                    'action': 'Merge the descriptions.',
                }
            ]
        ),
    )
    assert cons._skill_review_pass()[0] == 1
    kinds = {r.get('kind') for r in _pending()}
    assert 'observation' in kinds
    assert 'skill_patch' not in kinds


def test_an_invented_skill_name_is_refused(library, monkeypatch):
    _stub(
        monkeypatch,
        json.dumps(
            [{'name': 'no-such-skill', 'kind': 'delete', 'summary': 'Gone.', 'action': 'Delete.'}]
        ),
    )
    assert cons._skill_review_pass()[0] == 0
    assert _pending() == []


def test_a_skill_with_a_pending_proposal_is_not_filed_twice(library, monkeypatch):
    _stub(
        monkeypatch,
        json.dumps(
            [{'name': 'pdf-tools', 'kind': 'stale', 'summary': 'Dead weight.', 'action': 'Retire.'}]
        ),
    )
    assert cons._skill_review_pass()[0] == 1
    assert cons._skill_review_pass()[0] == 0
    assert len([r for r in _pending() if r.get('kind') == 'skill_delete']) == 1


def test_no_model_means_no_findings(library, monkeypatch):
    _stub(monkeypatch, '')
    assert cons._skill_review_pass() == (0, [])


def test_a_one_skill_library_skips_the_call(monkeypatch):
    """One skill cannot overlap anything, so the call is not spent. The
    catalogue is stubbed because the bundled repo root always contributes real
    skills to a live read."""
    monkeypatch.setattr(
        cons,
        '_skill_catalogue',
        lambda: [{'name': 'only-one', 'description': 'x', 'trigger': '', 'category': 'c',
                  'scope': 'agent', 'enabled': True, 'usageCount': 0, 'lastUsed': ''}],
    )
    calls = _stub(monkeypatch, '[]')
    assert cons._skill_review_pass() == (0, [])
    assert calls == []


def test_parse_rejects_junk():
    assert cons._parse_skill_findings('not json') == []
    assert cons._parse_skill_findings('[{"kind":"stale"}]') == []
