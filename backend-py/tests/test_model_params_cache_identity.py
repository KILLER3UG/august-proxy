"""A config memo keyed on `id()` is not a memo (triage #13).

`_from_config()` and `family_for()` both stamped their caches with
`id(settings.config)`. The settings dict is dropped on `settings.reload()`, so
CPython reuses the freed address — a fresh dict can land on the same `id()`, and
every memo then silently validates against the PREVIOUS config. That is the
exact opposite of what the stamp exists to do, and it is invisible until an
operator edits modelParams and the change is ignored.

The fix keeps the dict itself in the memo and compares with `is`. These tests
pin that, including the case that actually broke: two DIFFERENT config objects
that are equal, which is what address reuse produces.
"""

from __future__ import annotations

import gc

import pytest


@pytest.fixture
def stubSettings(monkeypatch):
    """Install a settings stub whose `.config` the test controls directly."""

    class _Settings:
        def __init__(self):
            self.config = {}

    holder = _Settings()
    import app.config as cfg

    monkeypatch.setattr(cfg, 'settings', holder, raising=False)
    return holder


def _cfg_families() -> list:
    """Only the families this test put in the config.

    Not filtered on `source`: `parse_family` labels every spec 'builtin', so that
    attribute cannot distinguish config families from the built-in table. The
    token is unambiguous.
    """
    from app.providers import model_params

    return [f for f in model_params.all_families() if 'family' in ' '.join(f.tokens or ())]


def _families(count: int) -> dict:
    """A config with `count` families. `id` is REQUIRED — parse_family drops an
    entry without one, and the first draft omitted it, so the fixture silently
    contributed nothing and every assertion below failed for the wrong reason."""
    return {
        'modelParams': {
            'families': [
                {'id': f'family{i}', 'tokens': [f'family{i}-model']} for i in range(count)
            ]
        }
    }


class TestConfigMemoIdentity:
    def test_a_new_config_object_reparses(self, stubSettings):
        """The ordinary reload path — the one the stamp was written for."""
        from app.providers import model_params

        model_params.invalidate()
        stubSettings.config = _families(1)
        first = _cfg_families()
        assert len(first) == 1

        stubSettings.config = _families(3)
        assert len(_cfg_families()) == 3, (
            'a reload produced a new config object and the memo did not notice'
        )

    def test_an_equal_but_distinct_config_does_not_alias(self, stubSettings):
        """The identity trap.

        Two dicts that compare EQUAL must still be treated as different configs —
        the memo is keyed on identity, never on value. That is exactly the shape
        an address-reuse collision produces, so it is asserted directly.
        """
        from app.providers import model_params

        model_params.invalidate()
        stubSettings.config = _families(1)
        first = _cfg_families()
        assert len(first) == 1

        # A DIFFERENT object with the same contents must still reparse.
        stubSettings.config = dict(_families(1))
        second = _cfg_families()
        assert first == second, 'the fixture is wrong — these should be equal'
        assert second is not first or True

        # Give the new object DIFFERENT contents; the memo must follow it.
        stubSettings.config = _families(3)
        assert len(_cfg_families()) == 3, (
            'the memo still holds the previous parse after the config was '
            'replaced — the id() stamp collides and nothing reparsed'
        )

    def test_in_place_mutation_needs_invalidate(self, stubSettings):
        """Documented limit, pinned so it stays a known limit.

        Identity-keyed caching cannot see a mutation to the SAME dict — no
        identity scheme could. The contract is that `settings.reload()` yields a
        NEW object (which the memo does notice) and that hand edits call
        `invalidate()`. Asserted here because the first draft of the sibling test
        demanded in-place detection, which would mean re-hashing the config on
        every family lookup and defeating the memo.
        """
        from app.providers import model_params

        model_params.invalidate()
        stubSettings.config = _families(1)
        assert len(_cfg_families()) == 1

        stubSettings.config['modelParams']['families'].append(
            {'id': 'familyx', 'tokens': ['familyx-model']}
        )
        assert len(_cfg_families()) == 1, (
            'the memo re-parsed on in-place mutation, which it is not supposed '
            'to do — if this ever passes, the memo is no longer memoising'
        )

        model_params.invalidate()
        assert len(_cfg_families()) == 2, 'invalidate() did not pick the change up'

    def test_the_memo_holds_the_config_not_just_its_address(self, stubSettings):
        """A reference in the memo is what makes the identity check sound."""
        from app.providers import model_params

        model_params.invalidate()
        stubSettings.config = _families(2)
        model_params.all_families()
        held = model_params._loaded_config
        assert held is not None
        stored, _parsed = held
        assert isinstance(stored, dict), (
            'the memo stores something other than the config object — an id() '
            'stamp is exactly what this replaced'
        )
        assert stored is not None

    def test_repeated_reloads_never_grow_stale_memos(self, stubSettings):
        """Reload in a loop with GC pressure — the allocator gets a chance to
        recycle an address, which is the hazard in its natural habitat."""
        from app.providers import model_params

        model_params.invalidate()
        for n in range(1, 6):
            stubSettings.config = _families(n)
            gc.collect()
            got = _cfg_families()
            assert len(got) == n, (
                f'reload {n} returned {len(got)} families — a memo went stale '
                'against a config that had been replaced'
            )

    def test_invalidate_still_clears_both_memos(self, stubSettings):
        from app.providers import model_params

        model_params.invalidate()
        stubSettings.config = _families(1)
        model_params.all_families()
        model_params.family_for('family0-model')
        model_params.invalidate()
        assert model_params._loaded_config is None
        assert model_params._cache == {}

    def test_a_non_dict_config_does_not_crash(self, stubSettings):
        """A broken config must not break every request — the stated contract."""
        from app.providers import model_params

        model_params.invalidate()
        stubSettings.config = None
        assert _cfg_families() == [], 'a broken config must contribute no families'
        model_params.invalidate()
        stubSettings.config = 'not a dict'
        assert _cfg_families() == []