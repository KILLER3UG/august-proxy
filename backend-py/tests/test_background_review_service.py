"""Background review *config* service tests (isolated data dir).

Covers save_config field merging and the config-change audit entry — the
sibling of test_alias_service.test_audit_recorded / test_fallback_service.
(The review *loop* is tested in test_background_review.py.)
"""
from app.services import background_review_service


def test_get_default_shape(isolated_data):
    cfg = background_review_service.get_config()
    assert "enabled" in cfg and "reviewModel" in cfg
    assert "reflectionModel" in cfg and "autoMemoryModel" in cfg
    assert cfg["enabled"] is False  # disabled by default


def test_save_partial_merge(isolated_data):
    out = background_review_service.save_config(review_model="claude-sonnet-4-7", actor="test")
    assert out["reviewModel"] == "claude-sonnet-4-7"
    # Unspecified fields keep their defaults.
    assert out["enabled"] is False
    # Persisted + reloaded.
    assert background_review_service.get_config()["reviewModel"] == "claude-sonnet-4-7"


def test_audit_recorded_on_save(isolated_data):
    """save_config must record a config-change audit entry (m6 parity with
    alias/fallback services) so self-configuration stays traceable."""
    from app.services.memory_store import list_config_audit

    background_review_service.save_config(
        review_model="claude-haiku-4-5", auto_memory_model="claude-sonnet-4-7", actor="test"
    )
    entries = list_config_audit(category="background_review")
    assert any(
        e["action"] == "update"
        and e["actor"] == "test"
        and e["after"].get("reviewModel") == "claude-haiku-4-5"
        for e in entries
    )


def test_audit_captures_before(isolated_data):
    """The audit `before` snapshot must reflect the prior config so a change
    is reversible/inspectable — not just the new state."""
    from app.services.memory_store import list_config_audit

    background_review_service.save_config(review_model="first-model", actor="test")
    background_review_service.save_config(review_model="second-model", actor="test")

    entries = list_config_audit(category="background_review")
    # Find the transition by `after` (list_config_audit's "newest first" is
    # nondeterministic when entries share a second-resolution created_at).
    transition = next(e for e in entries if e["after"].get("reviewModel") == "second-model")
    assert transition["before"].get("reviewModel") == "first-model"
