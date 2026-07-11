"""v1.1 — Test that save_auto_memory supports duplicate keys with updated_at."""
import pytest
import uuid
from app.services.memory import auto_memory
from app.services import memory_store

@pytest.fixture(autouse=True)
def _initDb():
    """Run init() so the migration is applied (idempotent)."""
    memory_store.init()
    yield

@pytest.fixture
def _testKey():
    """Per-test key so we don't pollute global state."""
    key = f'v11_test_{uuid.uuid4().hex[:8]}'
    yield key
    try:
        conn = auto_memory._conn()
        conn.execute('DELETE FROM auto_memories WHERE key = ?', (key,))
        conn.commit()
    except Exception:
        pass

def testSaveAutoMemoryTwiceWithSameKey(_testKey):
    """First save inserts, second save updates — no error."""
    key = _testKey
    auto_memory.save_auto_memory(key=key, content='first', importance=0.5)
    auto_memory.save_auto_memory(key=key, content='second', importance=0.7)
    conn = auto_memory._conn()
    row = conn.execute('SELECT content, importance, updated_at FROM auto_memories WHERE key = ?', (key,)).fetchone()
    assert row is not None
    assert row['content'] == 'second'
    assert row['importance'] == 0.7
    assert row['updated_at'] is not None
    assert row['updated_at'] != ''

def testAutoMemoriesTableHasUpdatedAtColumn():
    """Schema check: the column must exist after init()."""
    conn = auto_memory._conn()
    cols = [r['name'] for r in conn.execute('PRAGMA table_info(auto_memories)').fetchall()]
    assert 'updated_at' in cols, f'auto_memories columns: {cols}'