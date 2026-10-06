"""Item 7 — what an auto-applied change is actually able to touch.

The claim to test is not "the applier means well"; it is a file-system property:
a change the machine makes by itself writes ONE file, and cannot reach the rails
that gate it, the allow-list it is judged against, the system prompt, the tool
registry, or the sandbox and network policy.

So this measures. It snapshots the backend source tree, performs a real
auto-apply through the reviewer path, and diffs the result. A test that only
asserted the applier's return value would pass while a stray write happened.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from app.services import episode_miner
from app.services import harness_rails as rails
from app.services import harness_self_improve as hsi

_BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def brain(isolatedData):
    from app.services import memory_store

    memory_store.init()
    return isolatedData


def _fingerprint(root: Path) -> dict[str, str]:
    """Size + content hash for every source file under `root`, keyed by path.

    Content-hashed rather than timestamp-only, so a rewrite that writes identical
    bytes is not mistaken for a change, and a touch that changes mtime only is not
    mistaken for one either.
    """
    out: dict[str, str] = {}
    for p in sorted(root.rglob('*')):
        if not p.is_file() or p.suffix not in ('.py', '.json', '.md'):
            continue
        if '__pycache__' in p.parts:
            continue
        digest = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
        out[str(p)] = f'{p.stat().st_size}:{digest}'
    return out


def _arm() -> None:
    from app.services.brain_config_service import bustRuntimeCache, saveBrainConfig

    # Both ceiling kinds are armed deliberately: every test in this file is
    # about what a change can TOUCH, not about which kinds the switch automates
    # (test_harness_rails.TestAutonomyIsArmedPerKind owns that), and the default
    # arms skill_patch only, which would hold these creates for an unrelated reason.
    ok, err, _ = saveBrainConfig({
        'skillAutonomy': True,
        'autonomyBurnInCount': 0,
        'autoApplyPerDay': 10,
        'autonomyKinds': 'skill_patch,skill_create',
    })
    assert ok, err
    bustRuntimeCache()


def _episodeId() -> int:
    return episode_miner.save_episode(
        {
            'session_id': 'ses_contain',
            'kind': 'user_correction',
            'start_message_id': 1,
            'end_message_id': 3,
            'events': [{'role': 'user', 'text': 'Do not rebuild, just restart.'}],
            'outcome': 'resolved',
            'fingerprint_id': 'fp-contain',
        }
    )


def _cleanProposal(name: str = 'contained-skill', **payloadExtra) -> str:
    row = hsi.save_proposal(
        problem=f'the {name} skill needs a note',
        evidence='the user corrected this twice, in their own words',
        proposal='create the skill',
        rollback='restore the previous version',
        kind='skill_create',
        payload={
            'name': name,
            'description': 'container flow',
            'body': f'# {name}\n\nRestart the container instead of rebuilding it.\n',
            'trigger': 'container',
            'episodeIds': [_episodeId()],
            'origin': 'distilled',
            **payloadExtra,
        },
    )
    return str(row['id'])


def _forceKind(pid: str, kind: str) -> None:
    """The rails read the row's kind, and the store only accepts known kinds at
    file time, so a per-kind sweep rewrites the field it judges."""
    row = hsi.get_proposal(pid)
    row['kind'] = kind
    (hsi._proposals_dir() / f"{row['id']}.json").write_text(
        json.dumps(row, ensure_ascii=False), encoding='utf-8'
    )


def _prove_the_scan_bites() -> None:
    """Write one file under `app/` and require the scan to report exactly it.

    A green tree-scan means nothing if it cannot see a change. Deliberately
    called from inside the containment test rather than as its own test: a
    separate test that writes into `app/` races the one asserting `app/` is
    quiet whenever xdist runs them in parallel workers — which is how this file
    failed on the second run. One test, one worker, no interleaving.
    """
    probe = _BACKEND / 'app' / '_containment_probe.py'
    try:
        before = _fingerprint(_BACKEND / 'app')
        probe.write_text('# probe\n', encoding='utf-8')
        after = _fingerprint(_BACKEND / 'app')
        changed = [k for k in set(before) | set(after) if before.get(k) != after.get(k)]
        assert changed == [str(probe)], changed
    finally:
        probe.unlink(missing_ok=True)
    assert str(probe) not in _fingerprint(_BACKEND / 'app')


class TestTheAllowListIsTwoKinds:
    def test_exactly_two_kinds_may_auto_apply(self, brain):
        assert sorted(rails.AUTO_APPLIABLE_KINDS) == ['skill_create', 'skill_patch']

    def test_every_other_kind_in_the_vocabulary_is_held(self, brain):
        _arm()
        others = sorted(set(hsi.VALID_KINDS) - rails.AUTO_APPLIABLE_KINDS)
        assert {'brain_config', 'skill_delete', 'retire', 'promote', 'revert'} <= set(others)
        for kind in others:
            pid = _cleanProposal(name=f'kind-{kind}')
            _forceKind(pid, kind)
            out = rails.auto_apply_allowed(hsi.get_proposal(pid))
            assert out['allowed'] is False, (kind, out)
            assert out['rule'] == 'hard-kind', (kind, out)


class TestNothingOutsideTheSkillIsTouched:
    def test_an_auto_apply_writes_only_the_skill_file(self, brain, monkeypatch):
        _prove_the_scan_bites()
        _arm()
        before_app = _fingerprint(_BACKEND / 'app')
        _cleanProposal(name='only-this-file')

        class _Client:
            async def __call__(self, prompt):
                return 'KEEP — durable and justified'

        monkeypatch.setattr(
            'app.services.harness_self_improve.resolve_independent_reviewer',
            lambda producer, hint='': (_Client(), ''),
        )
        out = hsi.run_reviewer_pass()
        assert out['applied'] == 1, out

        after_app = _fingerprint(_BACKEND / 'app')
        changed = [
            k for k in set(before_app) | set(after_app) if before_app.get(k) != after_app.get(k)
        ]
        assert changed == [], f'the auto-apply touched backend source: {changed}'

        # The named files behind the claim, asserted by name so a refactor cannot
        # quietly move them out of the glob above and leave this test vacuous.
        for rel in (
            'app/services/harness_rails.py',
            'app/services/brain_config_service.py',
            'app/services/skill_service.py',
            'app/services/tool_registry.py',
        ):
            assert (_BACKEND / rel).is_file(), rel
        sandbox = _BACKEND / 'app' / 'services' / 'sandbox'
        assert sandbox.is_dir(), 'the sandbox policy tree moved; this test no longer covers it'
        assert not [k for k in changed if str(sandbox) in k]

    def test_a_payload_cannot_smuggle_a_config_change(self, brain, monkeypatch):
        """`skill_create` reads name/description/body/trigger and nothing else.
        A proposal that also carries a brain-config patch must not have it
        applied: the applier dispatches on kind, never on payload keys."""
        _arm()
        from app.services.brain_config_service import getRuntimeConfig

        before = dict(getRuntimeConfig())
        _cleanProposal(
            name='smuggle-attempt',
            patch={'maxAgentDepth': 5, 'enabled': False},
            brain_config={'maxAgentDepth': 5},
            auxiliary={'cognitive': {'orchestrator': {'max_agent_depth': 5}}},
        )

        class _Client:
            async def __call__(self, prompt):
                return 'KEEP — durable'

        monkeypatch.setattr(
            'app.services.harness_self_improve.resolve_independent_reviewer',
            lambda producer, hint='': (_Client(), ''),
        )
        out = hsi.run_reviewer_pass()
        assert out['applied'] == 1, out
        after = dict(getRuntimeConfig())
        assert after.get('maxAgentDepth') == before.get('maxAgentDepth')
        assert after.get('enabled') == before.get('enabled')
        assert after.get('skillAutonomy') is True, 'the switch it just used is unchanged'

    def test_a_skill_name_cannot_escape_the_skills_root(self, brain):
        from app.services.skill_service import SkillValidationError, _validateName

        for bad in ('../evil', 'a/b', '..\\evil', '/etc/passwd', '', 'x' * 200, '.hidden'):
            with pytest.raises(SkillValidationError):
                _validateName(bad)


class TestSupersedingIsNotAutomatic:
    """`_apply_skill_write` honours payload.supersedes by DISABLING a second
    skill in the same write. That is a real side effect on a file the proposal
    does not name, so it is not something the machine should do unwatched."""

    def test_a_superseding_proposal_is_held(self, brain):
        _arm()
        pid = _cleanProposal(name='superseder', supersedes='some-other-skill')
        out = rails.auto_apply_allowed(hsi.get_proposal(pid))
        assert out['allowed'] is False, out
        assert out['rule'] == 'supersedes-another-skill', out

    def test_an_empty_supersedes_still_passes(self, brain):
        """The applier tolerates '' (it means "nothing superseded"), so the rail
        must not treat the empty string as a second-skill write."""
        _arm()
        pid = _cleanProposal(name='plain', supersedes='')
        assert rails.auto_apply_allowed(hsi.get_proposal(pid))['allowed'] is True
