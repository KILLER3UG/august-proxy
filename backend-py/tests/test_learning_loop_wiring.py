"""Wiring tests: every learning-loop surface needs a live production caller.

The refine store shipped a complete write half (auto_refine, config setters)
behind a router that was later deleted as "dead"; only the reader survived, so
the store stayed permanently empty in production while 160+ unit tests proved
the functions work. Green tests prove behavior at the seam, not that anything
calls the seam. These assertions fail CI when a load-bearing wiring is
removed or was never added — the same trap the tool-registry parity tests
guard on the tools axis.

Kept cheap on purpose: module import + string anchors + regex scan of the
consolidation pass. No server, no model calls, no data writes.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import app.services.refine_store as rs
from app.services.memory_store import consolidation

_BACKEND = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (_BACKEND / rel).read_text(encoding='utf-8')


class TestRefineWiring:
    def test_consolidation_runs_the_refine_pass(self) -> None:
        """The refine entry point must have a live scheduled caller.

        It moved from _skill_learning_pass into the unified scheduler as the
        'refine' job (own cadence + ledger row + run-now), so the assertion
        follows the wiring: the job exists and calls the entry point."""
        import inspect

        from app.services import learning_scheduler as ls

        refine = ls.JOBS.get('refine')
        assert refine is not None, (
            'refine job unregistered: the scheduler no longer starts the '
            'refine pass and the store is dead again'
        )
        assert 'run_scheduled_refine' in inspect.getsource(refine.fn)

    def test_refine_pass_producer_uses_configured_hint(self) -> None:
        """The auto-refine config's producerModel must reach the LLM client —
        a hint silently ignored means config lies about behavior."""
        src = _read('app/services/refine_store.py')
        call_sites = re.findall(r'make_review_llm_client\([^)]*\)', src)
        assert call_sites, 'producer/reviewer must resolve through make_review_llm_client'
        hint_carrying = [c for c in call_sites if 'hint' in c or 'model' in c]
        assert len(hint_carrying) == len(call_sites), (
            f'client resolutions ignoring the model hint: {call_sites}'
        )

    def test_workbench_injects_refinements_block(self) -> None:
        src = _read('app/services/workbench/workbench.py')
        assert 'render_refinements_block' in src, (
            'prompt assembly no longer injects the refine store — writes '
            'would never reach the model window'
        )

    def test_curator_router_exposes_refine_state(self) -> None:
        """The UI reads refine state through a mounted route; dropping the
        endpoint while the store stays live reintroduces the write/read split.
        HTTP-level probe: this FastAPI keeps _IncludedRouter wrappers, so
        route-path introspection is not the contract — the request is."""
        from app.main import app
        from fastapi.testclient import TestClient

        src = _read('app/routers/curator.py')
        assert '/refine' in src
        client = TestClient(app)
        res = client.get('/api/curator/refine')
        assert res.status_code == 200, res.status_code
        body = res.json()
        assert 'entries' in body and 'config' in body and 'ledger' in body

    def test_inbox_count_route_answers(self) -> None:
        """The rail badge polls one cheap route across BOTH queues (harness
        proposals + memory retire); a missing route means the badge silently
        never shows again."""
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        res = client.get('/api/harness/proposals/inbox/count')
        assert res.status_code == 200, res.status_code
        body = res.json()
        assert {'harness', 'memory', 'total'} <= set(body)
        assert body['total'] == body['harness'] + body['memory']


class TestGuardrailLogWiring:
    def test_blocks_are_written_not_just_mined(self) -> None:
        """tool_guardrail_log had a schema, a privacy wipe list, and a miner
        docstring — and no writer for its whole life. The workbench block
        branch must record each block; the miner must read it back."""
        wb = _read('app/services/workbench/workbench.py')
        assert 'record_guardrail_block' in wb
        miner = _read('app/services/episode_miner.py')
        assert 'tool_guardrail_log' in miner and 'FROM tool_guardrail_log' in miner

    def test_block_roundtrips_into_hotspots(self) -> None:
        """Functional round trip: a recorded block must surface in the
        aggregate the refine evidence builder reads."""
        from app.services.episode_miner import guardrail_block_hotspots
        from app.services.workbench.tool_guardrails import record_guardrail_block

        record_guardrail_block('sess-wire', 'run_command', 'blocked: identical call repeats across turns')
        record_guardrail_block('sess-wire', 'run_command', 'blocked: identical call repeats across turns')
        hot = guardrail_block_hotspots(limit=10)
        hit = [h for h in hot if h.get('tool_name') == 'run_command']
        assert hit and int(hit[0]['n']) >= 2, hot

    def test_scheduled_evidence_cites_blocks_and_entries(self) -> None:
        """build_scheduled_evidence must include the hotspot section when
        blocks exist, and the active-entries section for dedupe — and be
        skipped (no model spend) when the store has nothing to say."""
        from app.services import refine_store as rs
        from app.services.workbench.tool_guardrails import record_guardrail_block

        record_guardrail_block('sess-wire', 'bulk', 'blocked: alternating ping-pong loop')
        rs.create_entry(
            kind='prompt_note',
            scope='global',
            content={'text': 'this repo pins pnpm-lock.yaml'},
            rationale='evidence test',
            expected_outcome='no lockfile regeneration',
            actor='test',
        )
        ev = rs.build_scheduled_evidence()
        assert 'bulk' in ev and 'pnpm-lock' in ev
        assert 'Guardrail block hot-spots' in ev and 'already in the store' in ev


class TestStaleWordingSingleSource:
    def test_all_stale_write_receipts_compose_the_constant(self) -> None:
        """One failure class, one sentence, four gates. A new site that
        hand-writes its own wording silently re-fragments the model's view."""
        from app.services.workbench.read_before_edit import STALE_WRITE_HEADLINE

        sources = [
            'app/services/workbench/read_before_edit.py',
            'app/services/workbench/workbench.py',
            'app/services/tool_registrations/file_tools.py',
        ]
        for rel in sources:
            assert 'STALE_WRITE_HEADLINE' in _read(rel), f'{rel} lost the shared wording'
        # No stale-receipt may pin the retired phrasing anymore.
        for rel in sources:
            assert 'changed since you read' not in _read(rel), f'{rel} kept a bespoke wording'
        assert 'modified since read' in STALE_WRITE_HEADLINE


class TestRenderBudget:
    def test_injection_is_bounded(self) -> None:
        """render_refinements_block once injected ALL active entries with no
        ceiling; bound it (SWE-Exp measured one good note beats four).
        conftest's isolatedData fixture points settings.dataDir at tmp_path."""
        for i in range(40):
            rs.create_entry(
                kind='prompt_note',
                scope='global',
                content={'text': f'note number {i} padding padding'},
                rationale='budget test',
                expected_outcome='bounded block',
                actor='test',
            )
        block = rs.render_refinements_block()
        assert block.count('\n- [') <= rs._MAX_INJECT_ENTRIES
        assert 'older entries' in block  # the cut is visible to the model


class TestSqliteStorage:
    """Part 22: the store lives in the brain DB, not a JSON directory."""

    def test_entries_land_in_sqlite_not_json_files(self) -> None:
        entry = rs.create_entry(
            kind='prompt_note',
            scope='global',
            content={'text': 'sqlite container'},
            rationale='P1',
            expected_outcome='no entries/*.json files',
            actor='test',
        )
        rows = rs._conn().execute(
            'SELECT doc FROM refine_entries WHERE id = ?', (entry['id'],)
        ).fetchall()
        assert len(rows) == 1
        legacy = rs._store_dir() / 'entries'
        jsons = list(legacy.glob('ref_*.json')) if legacy.is_dir() else []
        assert jsons == [], f'store wrote JSON files again: {jsons}'
        # Ledger rows land in refine_ledger too.
        ledger = rs.read_ledger(limit=10)
        assert any(r.get('action') == 'create' and r.get('entryId') == entry['id'] for r in ledger)

    def test_legacy_json_imported_once(self, tmp_path, monkeypatch) -> None:
        """A pre-SQLite install's entries dir + ledger.jsonl are imported on
        first use, then renamed aside; a second call never re-imports."""
        import json as _json

        base = tmp_path / 'refine_store'
        (base / 'entries').mkdir(parents=True)
        old = {
            'id': 'ref_prompt_note_legacy1',
            'kind': 'prompt_note',
            'scope': 'global',
            'sessionId': '',
            'createdAt': '2026-01-01T00:00:00Z',
            'updatedAt': '2026-01-01T00:00:00Z',
            'versions': [
                {'version': 1, 'op': 'create',
                 'content': {'text': 'legacy lockfile note'},
                 'rationale': 'old', 'expectedOutcome': 'old', 'at': '2026-01-01T00:00:00Z',
                 'actor': 'user'},
            ],
        }
        (base / 'entries' / 'ref_prompt_note_legacy1.json').write_text(
            _json.dumps(old), encoding='utf-8'
        )
        (base / 'ledger.jsonl').write_text(
            _json.dumps({'at': '2026-01-01T00:00:00Z', 'actor': 'user',
                         'action': 'create', 'entryId': 'ref_prompt_note_legacy1'}) + '\n',
            encoding='utf-8',
        )
        from app.config import settings

        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        entries = rs.list_entries(scope='global')
        assert any(e['id'] == 'ref_prompt_note_legacy1' for e in entries)
        assert not (base / 'entries').exists() and (base / 'entries.migrated').is_dir()
        # The journal imports on the first ledger read (separate touch).
        ledger = rs.read_ledger(limit=10)
        assert any(r.get('entryId') == 'ref_prompt_note_legacy1' for r in ledger)
        assert not (base / 'ledger.jsonl').exists()
        # Idempotent: import ran once; entries still exactly the legacy one.
        rs.list_entries()
        n = rs._conn().execute(
            'SELECT COUNT(*) AS c FROM refine_entries'
        ).fetchone()['c']
        assert n == len(entries)

    def test_privacy_lists_cover_the_new_tables(self) -> None:
        src = _read('app/routers/privacy.py')
        assert "'refine_entries'" in src and "'refine_ledger'" in src
        sess = _read('app/services/memory_store/sessions.py')
        assert "'refine_entries'" in sess
