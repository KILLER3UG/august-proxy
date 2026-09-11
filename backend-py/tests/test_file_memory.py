"""File-memory mode — ZCode-parity per-fact files + MEMORY-INDEX.md index (2026-09-12).

Contract pinned here:
  * a per-fact write creates <slug>.md with flat YAML frontmatter above one
    ## <title> section; updating an existing entry keeps its home file;
  * MEMORY-INDEX.md regenerates on every write/delete: `- [Title](file.md) — hook`
    lines; the index never parses as entries and never gets searched;
  * legacy behavior preserved: no frontmatter anywhere -> no MEMORY-INDEX.md at
    all (pure pre-0.18 workspaces keep their exact file set);
  * project_block switches to the injected index when file-memory is active;
  * search ranks description words alongside body (the recall hook works).
"""
from __future__ import annotations

from pathlib import Path

import pytest
from app.services import project_memory as pm


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    d = tmp_path / 'proj'
    d.mkdir()
    return d


# ── per-fact write ─────────────────────────────────────────────────────


def test_per_fact_write_creates_frontmattered_file(ws):
    e = pm.upsert_entry(ws, 'User Profile', 'trades perps, wants second opinions',
                        description='who the user is and how they use August',
                        kind='user', per_fact=True)
    root = pm.memory_root(ws)
    assert e.file == 'user-profile.md'
    text = (root / 'user-profile.md').read_text('utf-8')
    assert text.startswith('---\nname: user-profile\n')
    assert 'description: who the user is and how they use August\n' in text
    assert 'type: user\n---\n' in text
    assert '## User Profile' in text
    # round-trips through the legacy parser WITH frontmatter preserved
    pf = pm.parse_memory_md(text)
    assert pf.entries and pf.entries[0].title == 'User Profile'
    assert pm.render_memory_md(pf) == text


def test_update_keeps_home_file_not_a_second_fact(ws):
    pm.upsert_entry(ws, 'Deploy Rule', 'v1', description='d1', kind='project', per_fact=True)
    before = sorted(p.name for p in pm.memory_root(ws).glob('*.md'))
    e2 = pm.upsert_entry(ws, 'Deploy Rule', 'v2', description='d2', kind='project', per_fact=True)
    after = sorted(p.name for p in pm.memory_root(ws).glob('*.md'))
    assert before == after, 'update must not fork a new per-fact file'
    assert e2.file == 'deploy-rule.md'
    entry = pm.read_entries(ws, title='Deploy Rule')[0]
    assert entry.body == 'v2'


def test_legacy_mode_still_lands_in_memory_md(ws):
    e = pm.upsert_entry(ws, 'Old Section', 'body')  # per_fact defaults False
    assert e.file == 'memory.md'
    # purely-legacy workspace: no index is generated (format contract holds)
    assert not (pm.memory_root(ws) / 'MEMORY-INDEX.md').exists()


# ── MEMORY-INDEX.md index ────────────────────────────────────────────────────


def test_index_lists_entries_and_skips_itself(ws):
    pm.upsert_entry(ws, 'Repo Quirks', 'pytest needs venv',
                    description='how to run tests here', kind='reference', per_fact=True)
    pm.upsert_entry(ws, 'User Profile', 'perps trader',
                    description='who the user is', kind='user', per_fact=True)
    idx = (pm.memory_root(ws) / 'MEMORY-INDEX.md').read_text('utf-8')
    assert '- [Repo Quirks](repo-quirks.md) — how to run tests here' in idx
    assert '- [User Profile](user-profile.md) — who the user is' in idx
    # index lines never parse as entries (read_entries skips MEMORY-INDEX.md)
    titles = {e.title for e in pm.read_entries(ws)}
    assert titles == {'Repo Quirks', 'User Profile'}
    # and never mutate when written to
    pm.upsert_entry(ws, 'Another Fact', 'body', description='d', kind='project', per_fact=True)
    idx2 = (pm.memory_root(ws) / 'MEMORY-INDEX.md').read_text('utf-8')
    assert '[MEMORY-INDEX.md]' not in idx2 and '_3 memories._' in idx2


def test_index_regenerates_after_delete(ws):
    pm.upsert_entry(ws, 'Keep', 'a', description='ka', kind='project', per_fact=True)
    pm.upsert_entry(ws, 'Drop', 'b', description='db', kind='project', per_fact=True)
    assert pm.delete_entry(ws, 'Drop')
    assert not (pm.memory_root(ws) / 'drop.md').exists()  # emptied fact file unlinked
    idx = (pm.memory_root(ws) / 'MEMORY-INDEX.md').read_text('utf-8')
    assert '[Keep]' in idx and '[Drop]' not in idx


# ── session-start block ────────────────────────────────────────────────


def test_project_block_prefers_the_index(ws):
    pm.upsert_entry(ws, 'Repo Quirks', 'pytest needs venv',
                    description='how to run tests here', kind='reference', per_fact=True)
    block = pm.project_block(ws)
    assert block.startswith('<project_memory>')
    assert '- [Repo Quirks](repo-quirks.md) — how to run tests here' in block
    # legacy-only workspace keeps the original title-list shape
    ws2 = ws.parent / 'legacy'
    ws2.mkdir()
    pm.upsert_entry(ws2, 'Plain Section', 'x')
    block2 = pm.project_block(ws2)
    assert '- Plain Section' in block2 and 'repo-quirks' not in block2


# ── recall ─────────────────────────────────────────────────────────────


def test_search_ranks_description_words(ws):
    pm.upsert_entry(ws, 'Windows Tooling', 'python full path required',
                    description='quirks of running pytest on this machine',
                    kind='reference', per_fact=True)
    pm.upsert_entry(ws, 'Trading Doctrine', 'no sft ever',
                    description='pipeline rulings for the model',
                    kind='project', per_fact=True)
    hits = pm.search_entries(ws, 'pytest quirks machine', k=2)
    assert hits and hits[0].title == 'Windows Tooling', [h.title for h in hits]
