"""One independence rule for model reviewers.

Why this file exists: the rule "a reviewer must not be the model that produced
the change" (Part 10) was implemented inline in ``refine_store._review_refine_batch``,
and backlog item 10 adds a second reviewer — for skill proposals. Two copies of a
fail-closed rule drift apart on the first edit to either, so both callers use this
one instead.

The provider factory is imported **at call time on purpose**. Existing tests
monkeypatch ``app.services.workbench.providers.make_review_llm_client`` by path;
a module-level binding would let those tests pass while exercising nothing.
``tests/test_review_gate.py`` asserts both the absence of the binding and that a
by-path patch actually reaches this function.
"""

from __future__ import annotations

from typing import Any

__all__ = ['resolve_independent_reviewer']


def resolve_independent_reviewer(producer_model: str, hint: str = '') -> tuple[Any | None, str]:
    """Pick a reviewer client that is not the producer, or refuse with a reason.

    Fail-closed by contract: whenever the client is ``None`` the reason is
    non-empty, so a caller can neither apply silently nor log a blank cause. An
    empty ``producer_model`` is treated as *unknown*, not as "matches anything" —
    a turn that never recorded its model must not block a valid reviewer.
    """
    producer = (producer_model or '').strip()
    reviewer_model = (hint or '').strip()

    if producer and reviewer_model and producer == reviewer_model:
        return None, (
            f'reviewer model {reviewer_model!r} is the same as the producer — '
            'same-model judging is inert (Part 10 rule)'
        )

    try:
        from app.services.workbench.providers import make_review_llm_client

        client = make_review_llm_client(None, reviewer_model)
    except Exception as exc:  # noqa: BLE001 — fail closed on ANY factory fault
        # Named, not the raw message: reasons land in a lifecycle row a user may
        # read, and provider exceptions have been known to carry request details.
        return None, f'reviewer could not be created: {type(exc).__name__}'

    if client is None:
        return None, 'no reviewer model available'
    return client, ''
