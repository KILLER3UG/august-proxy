"""v1.1 — Test that save_auto_memory supports duplicate keys with updated_at."""
import pytest
import uuid
from app.services.memory import auto_memory
from app.services import memory_store


@pytest.fixture(autouse=True)
def _init_db():
    """Run init() so the migration is applied (idempotent)."""
    memory_store.init()
    yield


@pytest.fixture
def _test_key():
    """Per-test key so we don't pollute global state."""
    key = f"v11_test_{uuid.uuid4().hex[:8]}"
    yield key
    # cleanup
    try:
        conn = auto_memory._conn()
        conn.execute("DELETE FROM auto_memories WHERE key = ?", (key,))
        conn.commit()
    except Exception:
        pass


def test_save_auto_memory_twice_with_same_key(_test_key):
    """First save inserts, second save updates — no error."""
    key = _test_key
    # First call — should insert
    auto_memory.save_auto_memory(key=key, content="first", importance=0.5)
    # Second call with same key — should update (not crash)
    auto_memory.save_auto_memory(key=key, content="second", importance=0.7)
    # Verify the row reflects the second save
    conn = auto_memory._conn()
    row = conn.execute(
        "SELECT content, importance, updated_at FROM auto_memories WHERE key = ?",
        (key,),
    ).fetchone()
    assert row is not None
    assert row["content"] == "second"
    assert row["importance"] == 0.7
    assert row["updated_at"] is not None
    assert row["updated_at"] != ""  # populated, not empty


def test_auto_memories_table_has_updated_at_column():
    """Schema check: the column must exist after init()."""
    conn = auto_memory._conn()
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(auto_memories)").fetchall()]
    assert "updated_at" in cols, f"auto_memories columns: {cols}"
