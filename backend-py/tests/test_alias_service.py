"""Alias service tests — CRUD, validation, audit (isolated data dir)."""
import pytest
from app.services import alias_service


def test_crud_roundtrip(isolated_data):
    entry = alias_service.create_alias(
        alias="fast", target_model="claude-sonnet-4-7", target_provider="Anthropic", actor="test"
    )
    assert entry["alias"] == "fast"
    assert entry["targetModel"] == "claude-sonnet-4-7"

    listed = alias_service.list_aliases()
    assert any(a["alias"] == "fast" for a in listed)

    updated = alias_service.update_alias("fast", target_model="claude-haiku-4-5", actor="test")
    assert updated["targetModel"] == "claude-haiku-4-5"

    assert alias_service.delete_alias("fast", actor="test") is True
    assert alias_service.delete_alias("fast", actor="test") is False  # already gone


def test_unknown_provider_rejected(isolated_data):
    with pytest.raises(ValueError):
        alias_service.create_alias(
            alias="bad", target_model="m", target_provider="ZZZ_NotAProvider", actor="test"
        )


def test_known_provider_accepted(isolated_data):
    # Anthropic is a built-in provider; the provider check should pass even
    # without credentials configured (the model check is loose).
    ok, _ = alias_service.validate_target("Anthropic", "claude-sonnet-4-7")
    assert ok is True


def test_replace_validates_each(isolated_data):
    with pytest.raises(ValueError):
        alias_service.replace_aliases(
            [{"alias": "ok", "targetModel": "claude-sonnet-4-7", "targetProvider": "Anthropic"},
             {"alias": "bad", "targetModel": "m", "targetProvider": "Nope"}],
            actor="test",
        )


def test_audit_recorded(isolated_data):
    from app.services.memory_store import list_config_audit

    alias_service.create_alias(
        alias="audited", target_model="claude-sonnet-4-7", target_provider="Anthropic", actor="test"
    )
    entries = list_config_audit(category="alias")
    assert any(e["action"] == "create" and e["after"].get("alias") == "audited" for e in entries)
