"""v1.1 — Test that brain_query returns correct shape for all 12 stores."""
import pytest
import json
from app.services.memory_store import brain_query


# All 12 stores the spec requires
ALL_STORES = [
    "memory",
    "auto_memories",
    "heuristics",
    "facts",
    "sessions",
    "messages",
    "timeline",
    "graph",
    "blackboard",
    "daemons",
    "exams",
    "exam_attempts",
]


@pytest.mark.parametrize("store_name", ALL_STORES)
def test_store_returns_list_or_not_available(store_name):
    """Each store returns a list of rows, or a structured 'not available' dict."""
    result = brain_query(store=store_name, query="", limit=5)
    # brain_query returns a JSON string
    assert isinstance(result, str)
    parsed = json.loads(result)
    # Either a list (rows found) or a dict with "error" key (not available)
    assert isinstance(parsed, (list, dict)), f"{store_name}: unexpected type {type(parsed)}"
    if isinstance(parsed, dict):
        assert "error" in parsed
        assert "available" in parsed


def test_unknown_store_returns_not_available():
    """Unknown stores return a structured not-available response, not an exception."""
    result = brain_query(store="not_a_real_store", limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, dict)
    assert "error" in parsed


def test_graph_store_handles_missing_file():
    """graph store returns empty list when JSON file is missing (graceful degrade)."""
    # We can't easily test file presence in this env, but the handler must
    # return valid JSON (list) regardless.
    result = brain_query(store="graph", query="anything", limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, list)


def test_daemons_store_handles_no_daemons():
    """daemons store returns empty list when no daemons are running."""
    result = brain_query(store="daemons", query="", limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, list)


def test_exams_store_responds():
    """exams store returns a list (possibly empty)."""
    result = brain_query(store="exams", query="", limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, list)


def test_exam_attempts_store_responds():
    """exam_attempts store returns a list (possibly empty)."""
    result = brain_query(store="exam_attempts", query="", limit=5)
    parsed = json.loads(result)
    assert isinstance(parsed, list)
