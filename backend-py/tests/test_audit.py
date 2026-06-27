"""Config audit log tests (isolated data dir)."""
from app.services.memory_store import list_config_audit, record_config_audit


def test_record_and_list(isolated_data):
    rid = record_config_audit("alias", "create", actor="test", before=None, after={"alias": "x"})
    assert rid > 0

    entries = list_config_audit(category="alias")
    assert any(e["after"] == {"alias": "x"} for e in entries)


def test_before_after_json_roundtrip(isolated_data):
    record_config_audit("agent", "update", actor="t", before={"a": 1}, after={"a": 2})
    entries = list_config_audit(category="agent")
    e = next(x for x in entries if x["action"] == "update")
    assert e["before"] == {"a": 1}
    assert e["after"] == {"a": 2}


def test_limit_respected(isolated_data):
    for i in range(5):
        record_config_audit("fallback", "configure", actor="t", before=None, after={"i": i})
    assert len(list_config_audit(category="fallback", limit=3)) == 3
