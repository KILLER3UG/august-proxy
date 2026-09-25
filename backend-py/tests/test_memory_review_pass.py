"""The LLM memory-review pass (consolidation's read across global + projects).

The deterministic consolidation passes can only compare rows inside one store,
so a global fact contradicted by a project note was invisible. This pass puts
both in front of a model. What is pinned here:

  1. the corpus really spans BOTH stores, and bot-scoped facts stay out of it
  2. a model verdict becomes a proposal — and NEVER an edit to a fact
  3. an id the model invented is refused (an approvable proposal must be
     actionable when a human approves it)
  4. the same finding is not filed again on the next pass
  5. no model / garbage output / a one-entry corpus all mean "no findings", not
     an error and not a wipe
"""

from __future__ import annotations

import json

import pytest
from app.services import memory_store
from app.services.memory_store import consolidation as cons


@pytest.fixture
def project_ws(tmp_path):
    ws = tmp_path / 'blog'
    mem = ws / '.aug' / 'memory'
    mem.mkdir(parents=True)
    (mem / 'memory.md').write_text(
        '# Blog\n\n## Deploy target\n\nCloudflare Pages, branch deploys only.\n', 'utf-8'
    )
    return ws


def _seed_globals() -> None:
    memory_store.save_fact('user:deploys', {'fact': 'Deploys to Cloudflare Pages.'}, title='Deploys')
    memory_store.save_fact('user:city', {'fact': 'Lives in Dapitan.'}, title='City')


def _stub_model(monkeypatch, reply: str) -> None:
    monkeypatch.setattr(cons, '_model_complete', lambda system, user: reply)


def _review_proposals() -> list[dict]:
    rows = memory_store.list_proposals('consolidation', status='pending')
    out = []
    for r in rows:
        if str(r.get('proposalType') or '') != cons._REVIEW_KIND:
            continue
        content = r.get('content')
        out.append(json.loads(content) if isinstance(content, str) else content)
    return out


# ── 1 · the corpus spans both stores ────────────────────────────────────────


def test_corpus_includes_global_facts_and_project_entries(monkeypatch, project_ws):
    _seed_globals()
    monkeypatch.setattr(
        'app.services.harness_promote._known_workspaces', lambda: [str(project_ws)]
    )
    corpus = cons._memory_corpus()
    ids = {c['id'] for c in corpus}
    assert 'user:deploys' in ids
    assert 'user:city' in ids
    project = [c for c in corpus if c['where'].startswith('project:')]
    assert project, 'project memory must be part of the review corpus'
    assert project[0]['id'] == 'project:blog:Deploy target'


def test_corpus_leaves_bot_scoped_facts_out(monkeypatch):
    """A bot's private memory is another audience's; reviewing it against the
    global set would propose exactly the cross-scope merges the SQL passes
    refuse to make."""
    _seed_globals()
    memory_store.save_fact(
        'bot:note', {'fact': 'Private to one agent.'}, title='Private', scope='bot:alpha'
    )
    ids = {c['id'] for c in cons._memory_corpus()}
    assert 'bot:note' not in ids
    assert 'user:deploys' in ids


# ── 2 + 3 + 4 · proposals, not mutations ────────────────────────────────────


def test_a_finding_is_filed_as_a_proposal_and_touches_no_fact(monkeypatch):
    _seed_globals()
    _stub_model(
        monkeypatch,
        json.dumps(
            [
                {
                    'kind': 'duplicate',
                    'ids': ['user:deploys', 'user:city'],
                    'summary': 'Two entries describe the same deployment setup.',
                    'action': 'Merge them.',
                }
            ]
        ),
    )
    before = {r['key'] for r in cons._load_active_facts()}
    filed, notes = cons._memory_review_pass()
    assert filed == 1
    assert notes and 'duplicate' in notes[0]
    stored = _review_proposals()
    assert stored and stored[0]['ids'] == ['user:deploys', 'user:city']
    # The pass proposes; a human decides. Nothing about the store moved.
    assert {r['key'] for r in cons._load_active_facts()} == before


def test_an_invented_id_is_refused(monkeypatch):
    """A proposal naming a fact that does not exist cannot be applied when
    approved, so it must not be filed at all."""
    _seed_globals()
    _stub_model(
        monkeypatch,
        json.dumps(
            [
                {
                    'kind': 'stale',
                    'ids': ['user:never-stored'],
                    'summary': 'Outdated.',
                    'action': 'Retire it.',
                }
            ]
        ),
    )
    filed, _notes = cons._memory_review_pass()
    assert filed == 0
    assert _review_proposals() == []


def test_the_same_finding_is_not_filed_twice(monkeypatch):
    _seed_globals()
    _stub_model(
        monkeypatch,
        json.dumps(
            [
                {
                    'kind': 'duplicate',
                    'ids': ['user:city', 'user:deploys'],
                    'summary': 'Duplicates.',
                    'action': 'Merge.',
                }
            ]
        ),
    )
    first, _ = cons._memory_review_pass()
    second, _ = cons._memory_review_pass()
    assert first == 1
    assert second == 0, 'a repeat verdict must not pile up identical proposals'
    assert len(_review_proposals()) == 1


def test_signature_ignores_id_order():
    a = {'kind': 'duplicate', 'ids': ['x', 'y']}
    b = {'kind': 'duplicate', 'ids': ['y', 'x']}
    assert cons._finding_signature(a) == cons._finding_signature(b)


# ── 5 · the no-op paths ─────────────────────────────────────────────────────


def test_no_model_means_no_findings_and_no_error(monkeypatch):
    _seed_globals()
    monkeypatch.setattr(cons, '_model_complete', lambda system, user: '')
    filed, notes = cons._memory_review_pass()
    assert (filed, notes) == (0, [])


def test_a_single_entry_corpus_skips_the_call(monkeypatch):
    """One memory cannot disagree with anything; do not spend a call on it."""
    memory_store.save_fact('user:only', {'fact': 'Only one.'}, title='Only')
    called = []
    monkeypatch.setattr(
        cons, '_model_complete', lambda system, user: called.append(1) or '[]'
    )
    assert cons._memory_review_pass() == (0, [])
    assert called == []


@pytest.mark.parametrize(
    'raw',
    ['not json at all', '', '{"kind":"duplicate"}', '[]', '[{"kind":"x","ids":[]}]'],
)
def test_unparseable_output_is_no_findings(raw):
    assert cons._parse_findings(raw) == [] or raw == '[]'


def test_parse_findings_accepts_a_fenced_array():
    raw = '```json\n' + json.dumps(
        [{'kind': 'stale', 'ids': ['a'], 'summary': 'Old.'}]
    ) + '\n```'
    out = cons._parse_findings(raw)
    assert out == [{'kind': 'stale', 'ids': ['a'], 'summary': 'Old.', 'action': ''}]


def test_run_consolidation_reports_the_review_count(monkeypatch):
    _seed_globals()
    _stub_model(
        monkeypatch,
        json.dumps(
            [{'kind': 'duplicate', 'ids': ['user:deploys', 'user:city'], 'summary': 'Same.'}]
        ),
    )
    summary = cons.run_consolidation(modelSummarize=False)
    assert 'error' not in summary
    assert summary['memoryReviewProposed'] == 1
