"""The shared independent-reviewer gate (backlog item 8).

One rule, two callers: the refine reviewer in `refine_store` and the
skill-proposal reviewer that Pass 2 adds. The Part 10 standing rule — a reviewer
judging the same model that produced the change is inert — existed once already,
inside `_review_refine_batch`. This module moves it out so the second caller
cannot grow a variant of it.

The provider factory MUST be imported at call time, not at module import. The
existing refine tests monkeypatch `app.services.workbench.providers.make_review_llm_client`
by path; if this module grabbed the symbol at import, those tests would keep
passing while exercising nothing — the worst kind of green. Two tests below fail
if someone "optimises" that import to the top of the file.
"""

from __future__ import annotations

import pytest
from app.services import review_gate


class TestIndependenceRule:
    def test_the_same_model_cannot_review_its_own_change(self):
        client, reason = review_gate.resolve_independent_reviewer('deepseek-flash', 'deepseek-flash')
        assert client is None
        assert 'same as the producer' in reason
        # Fail closed: a reason is mandatory whenever there is no reviewer.
        assert reason

    def test_a_different_model_is_allowed(self, monkeypatch):
        sentinal = object()
        monkeypatch.setattr(
            'app.services.workbench.providers.make_review_llm_client',
            lambda provider, hint: sentinal,
        )
        client, reason = review_gate.resolve_independent_reviewer('deepseek-flash', 'claude-sonnet-5')
        assert client is sentinal
        assert reason == ''

    def test_no_reviewer_available_fails_closed_with_a_reason(self, monkeypatch):
        monkeypatch.setattr(
            'app.services.workbench.providers.make_review_llm_client',
            lambda provider, hint: None,
        )
        client, reason = review_gate.resolve_independent_reviewer('deepseek-flash', 'claude-sonnet-5')
        assert client is None
        assert 'no reviewer' in reason.lower()

    def test_a_factory_that_raises_does_not_escape(self, monkeypatch):
        def boom(provider, hint):
            raise RuntimeError('upstream exploded')

        monkeypatch.setattr('app.services.workbench.providers.make_review_llm_client', boom)
        client, reason = review_gate.resolve_independent_reviewer('a', 'b')
        assert client is None
        assert 'upstream exploded' not in reason  # typed, not the raw message
        assert 'RuntimeError' in reason

    def test_an_unnamed_producer_still_gets_a_reviewer(self, monkeypatch):
        """A turn that did not record its model must not be treated as if the
        reviewer were proven to be the producer."""
        sentinal = object()
        monkeypatch.setattr(
            'app.services.workbench.providers.make_review_llm_client',
            lambda provider, hint: sentinal,
        )
        client, _reason = review_gate.resolve_independent_reviewer('', 'claude-sonnet-5')
        assert client is sentinal


class TestTheImportIsLazy:
    def test_the_factory_is_not_bound_at_module_import(self):
        """If this ever gains a module-level binding, the by-path monkeypatches
        in refine_store's tests would silently stop reaching the code."""
        assert not hasattr(review_gate, 'make_review_llm_client')

    def test_source_has_no_module_level_import_of_the_factory(self):
        import inspect

        src = inspect.getsource(review_gate)
        # Only real import statements count — an earlier version of this test
        # matched the name anywhere at column 0 and so "found" an import inside
        # the module docstring. The behavioral test below is the real guard;
        # this one exists to name the intent.
        top_level = [
            ln
            for ln in src.splitlines()
            if ln.startswith(('import ', 'from ')) and 'make_review_llm_client' in ln
        ]
        assert top_level == [], f'factory bound at module level: {top_level}'

    def test_patching_by_path_reaches_the_caller(self, monkeypatch):
        """The behavioral half of the same guarantee: patch the provider module
        and this gate must use the replacement."""
        calls = []

        def fake(provider, hint):
            calls.append(hint)
            return object()

        monkeypatch.setattr('app.services.workbench.providers.make_review_llm_client', fake)
        review_gate.resolve_independent_reviewer('producer-x', 'reviewer-y')
        assert calls == ['reviewer-y']


class TestRefineStoreReusesTheGate:
    """Item 8's point: one rule, not two implementations."""

    def test_refine_reviewer_defers_independence_to_the_gate(self):
        import inspect

        from app.services import refine_store

        src = inspect.getsource(refine_store._review_refine_batch)
        assert 'resolve_independent_reviewer' in src, (
            '_review_refine_batch grew its own independence check again'
        )
        assert 'same as the producer' not in src, (
            'the rule text should live in review_gate, not be duplicated here'
        )


@pytest.mark.parametrize('producer,hint', [('m', 'm'), ('', '')])
def test_fail_closed_never_returns_a_client_without_a_reason(producer, hint):
    client, reason = review_gate.resolve_independent_reviewer(producer, hint)
    if client is None:
        assert reason
