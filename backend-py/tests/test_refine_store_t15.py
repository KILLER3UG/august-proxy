"""T15 — versioned harness-state refinement with rollback."""

from __future__ import annotations

import json

import pytest
from app.services import refine_store as rs


def _mk(
    kind: str = 'prompt_note',
    scope: str = 'global',
    session_id: str = '',
    content: dict | None = None,
    rationale: str = 'why',
    expected: str = 'what should improve',
) -> dict:
    return rs.create_entry(
        kind=kind,
        scope=scope,
        content=content if content is not None else {'text': 'note text'},
        rationale=rationale,
        expected_outcome=expected,
        session_id=session_id,
    )


# ---------------------------------------------------------------------------
# Content validation
# ---------------------------------------------------------------------------


class TestValidateContent:
    def testUnknownKind(self) -> None:
        ok, reason = rs.validate_content('nope', {'text': 'x'})
        assert not ok and 'unknown kind' in reason

    def testMissingRequiredKey(self) -> None:
        ok, reason = rs.validate_content('prompt_note', {})
        assert not ok and 'non-empty' in reason
        ok, reason = rs.validate_content('prompt_note', {'other': 1})
        assert not ok and 'text' in reason

    def testSkillNeedsNameAndDescription(self) -> None:
        ok, _ = rs.validate_content('skill', {'name': 'x'})
        assert not ok
        ok, _ = rs.validate_content('skill', {'name': 'x', 'description': 'd'})
        assert ok

    def testOversizedValue(self) -> None:
        ok, reason = rs.validate_content('memory', {'text': 'x' * 9000})
        assert not ok and 'exceeds' in reason

    def testNonSerializableValue(self) -> None:
        ok, reason = rs.validate_content('memory', {'text': 'x', 'obj': object()})
        assert not ok and 'JSON-serializable' in reason


# ---------------------------------------------------------------------------
# Entry CRUD + versioning
# ---------------------------------------------------------------------------


class TestEntryVersioning:
    def testCreateIsVersionOne(self) -> None:
        entry = _mk()
        assert entry['id'].startswith('ref_prompt_note_')
        versions = entry['versions']
        assert len(versions) == 1
        assert versions[0]['version'] == 1
        assert versions[0]['op'] == 'create'
        assert versions[0]['rationale'] == 'why'
        assert versions[0]['expectedOutcome'] == 'what should improve'

    def testUpdateAppendsVersion(self) -> None:
        entry = _mk()
        updated = rs.update_entry(entry['id'], {'text': 'better'}, 'r2', 'e2')
        assert len(updated['versions']) == 2
        assert updated['versions'][1]['op'] == 'update'
        assert rs.latest_version(updated)['content'] == {'text': 'better'}
        # History is append-only: the creating version is still there.
        assert updated['versions'][0]['content'] == {'text': 'note text'}

    def testDeleteDeactivates(self) -> None:
        entry = _mk()
        deleted = rs.delete_entry(entry['id'], 'obsolete', 'cleaner store')
        assert not rs.is_active(deleted)
        assert rs.latest_version(deleted)['op'] == 'delete'
        # Still on disk with full history.
        assert rs.get_entry(entry['id']) is not None

    def testLocalEntryNeedsSession(self) -> None:
        with pytest.raises(ValueError, match='session id'):
            _mk(scope='local')

    def testCreateRequiresRationaleAndOutcome(self) -> None:
        with pytest.raises(ValueError, match='rationale'):
            _mk(rationale='  ')
        with pytest.raises(ValueError, match='rationale'):
            _mk(expected='   ')

    def testUpdateUnknownEntry(self) -> None:
        with pytest.raises(ValueError, match='not found'):
            rs.update_entry('ref_prompt_note_missing', {'text': 'x'}, 'r', 'e')

    def testLedgerRecordsMutations(self) -> None:
        entry = _mk()
        rs.update_entry(entry['id'], {'text': 'v2'}, 'r2', 'e2')
        ledger = rs.read_ledger(limit=10)
        actions = [row.get('action') for row in ledger]
        assert 'create' in actions and 'update' in actions


# ---------------------------------------------------------------------------
# Rollback by entry id
# ---------------------------------------------------------------------------


class TestRollback:
    def testRollbackRestoresPreviousVersion(self) -> None:
        entry = _mk()
        rs.update_entry(entry['id'], {'text': 'changed'}, 'r2', 'e2')
        rolled = rs.rollback_entry(entry['id'], rationale='undo it')
        assert rs.is_active(rolled)
        latest = rs.latest_version(rolled)
        assert latest['op'] == 'rollback'
        assert latest['content'] == {'text': 'note text'}
        assert latest['version'] == 3
        assert 'undo it' in latest['rationale']

    def testRollbackSingleVersionCreateDeactivates(self) -> None:
        entry = _mk()
        rolled = rs.rollback_entry(entry['id'])
        assert not rs.is_active(rolled)
        assert rs.latest_version(rolled)['op'] == 'delete'

    def testRollbackRevivesDeletedEntry(self) -> None:
        entry = _mk()
        rs.update_entry(entry['id'], {'text': 'v2'}, 'r2', 'e2')
        rs.delete_entry(entry['id'], 'gone', 'e3')
        rolled = rs.rollback_entry(entry['id'])
        assert rs.is_active(rolled)
        assert rs.latest_version(rolled)['content'] == {'text': 'v2'}

    def testRollbackUnknownEntry(self) -> None:
        with pytest.raises(ValueError, match='not found'):
            rs.rollback_entry('ref_memory_nope')

    def testRollbackIsAppendOnly(self) -> None:
        entry = _mk()
        rs.update_entry(entry['id'], {'text': 'v2'}, 'r2', 'e2')
        rolled = rs.rollback_entry(entry['id'])
        # All three versions plus the rollback are preserved.
        assert len(rolled['versions']) == 3
        assert [v['op'] for v in rolled['versions']] == ['create', 'update', 'rollback']


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


class TestListEntries:
    def testFiltersAndLocalFirst(self) -> None:
        g = _mk()  # global
        l1 = _mk(scope='local', session_id='s1', content={'text': 'local note'})
        _mk(scope='local', session_id='s2')  # other session
        _mk(kind='skill', content={'name': 'sk', 'description': 'd'})

        # Global + this session's local entries, deleted excluded.
        entries = rs.list_entries(session_id='s1')
        ids = [e['id'] for e in entries]
        assert l1['id'] in ids and g['id'] in ids
        assert entries[0]['scope'] == 'local'  # local first

        globals_only = rs.list_entries(scope='global')
        assert all(e['scope'] == 'global' for e in globals_only)

        skills = rs.list_entries(kind='skill')
        assert len(skills) == 1 and skills[0]['kind'] == 'skill'

    def testDeletedHiddenUnlessAsked(self) -> None:
        entry = _mk()
        rs.delete_entry(entry['id'], 'r', 'e')
        assert rs.list_entries() == []
        assert len(rs.list_entries(include_deleted=True)) == 1


# ---------------------------------------------------------------------------
# Edit validation (the refine-pass contract)
# ---------------------------------------------------------------------------


class TestValidateEdit:
    def testCreateContract(self) -> None:
        ok, _ = rs.validate_edit(
            {
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': 'x'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            },
            refine_scope='global',
            session_id='',
        )
        assert ok

    def testCreateNeedsKindAndScope(self) -> None:
        base = {'op': 'create', 'content': {'text': 'x'}, 'rationale': 'r', 'expectedOutcome': 'e'}
        ok, reason = rs.validate_edit(dict(base), refine_scope='global', session_id='')
        assert not ok and 'kind' in reason
        ok, reason = rs.validate_edit(
            dict(base, kind='prompt_note'), refine_scope='global', session_id=''
        )
        assert not ok and 'scope' in reason

    def testLocalRefineCannotCreateGlobal(self) -> None:
        ok, reason = rs.validate_edit(
            {
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': 'x'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            },
            refine_scope='local',
            session_id='s1',
        )
        assert not ok and 'local refine' in reason

    def testGlobalEntriesReadOnlyDuringLocalRefine(self) -> None:
        g = _mk()
        for op in ('update', 'delete'):
            ok, reason = rs.validate_edit(
                {
                    'op': op,
                    'id': g['id'],
                    'content': {'text': 'hax'},
                    'rationale': 'r',
                    'expectedOutcome': 'e',
                },
                refine_scope='local',
                session_id='s1',
            )
            assert not ok and 'read-only' in reason

    def testGlobalRefineCanEditGlobal(self) -> None:
        g = _mk()
        ok, _ = rs.validate_edit(
            {
                'op': 'update',
                'id': g['id'],
                'content': {'text': 'new'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            },
            refine_scope='global',
            session_id='',
        )
        assert ok

    def testGlobalRefineCannotEditLocalEntries(self) -> None:
        local = _mk(scope='local', session_id='s1')
        ok, reason = rs.validate_edit(
            {
                'op': 'update',
                'id': local['id'],
                'content': {'text': 'hax'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            },
            refine_scope='global',
            session_id='',
        )
        assert not ok and 'belongs to one session' in reason

    def testUpdateDeletedEntryRejected(self) -> None:
        entry = _mk()
        rs.delete_entry(entry['id'], 'r', 'e')
        ok, reason = rs.validate_edit(
            {
                'op': 'update',
                'id': entry['id'],
                'content': {'text': 'zombie'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            },
            refine_scope='global',
            session_id='',
        )
        assert not ok and 'roll' in reason

    def testRationaleAndOutcomeMandatory(self) -> None:
        for missing in ('rationale', 'expectedOutcome'):
            edit = {
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': 'x'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            }
            edit.pop(missing)
            ok, reason = rs.validate_edit(edit, refine_scope='global', session_id='')
            assert not ok
            assert missing.lower() in reason.lower()

    def testSnakeCaseOutcomeAlias(self) -> None:
        ok, _ = rs.validate_edit(
            {
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': 'x'},
                'rationale': 'r',
                'expected_outcome': 'e',
            },
            refine_scope='global',
            session_id='',
        )
        assert ok


# ---------------------------------------------------------------------------
# apply_edits: mixed batches, per-edit fail-closed
# ---------------------------------------------------------------------------


class TestApplyEdits:
    def testMixedBatch(self) -> None:
        existing = _mk()
        edits = [
            {  # good create
                'op': 'create',
                'kind': 'memory',
                'scope': 'global',
                'content': {'text': 'learned'},
                'rationale': 'r1',
                'expectedOutcome': 'e1',
            },
            {'op': 'update', 'rationale': 'no target'},  # bad: no id
            {  # good update
                'op': 'update',
                'id': existing['id'],
                'content': {'text': 'updated'},
                'rationale': 'r2',
                'expectedOutcome': 'e2',
            },
            {  # bad: unknown entry
                'op': 'delete',
                'id': 'ref_prompt_note_ghost',
                'rationale': 'r3',
                'expectedOutcome': 'e3',
            },
        ]
        result = rs.apply_edits(
            edits, refine_id='refine_test', refine_scope='global', session_id=''
        )
        assert len(result['applied']) == 2
        assert len(result['rejected']) == 2
        assert result['applied'][0]['op'] == 'create'
        assert result['applied'][0]['kind'] == 'memory'
        assert result['applied'][1]['id'] == existing['id']
        assert all(r['reason'] for r in result['rejected'])

    def testBatchCap(self) -> None:
        edits = [
            {
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': f'n{i}'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            }
            for i in range(30)
        ]
        result = rs.apply_edits(
            edits, refine_id='refine_cap', refine_scope='global', session_id=''
        )
        assert len(result['applied']) == rs._MAX_EDITS_PER_PASS


# ---------------------------------------------------------------------------
# parse_refine_response
# ---------------------------------------------------------------------------


class TestParseRefineResponse:
    def testBareList(self) -> None:
        edits = rs.parse_refine_response('[{"op": "delete", "id": "x"}]')
        assert edits == [{'op': 'delete', 'id': 'x'}]

    def testEditsObject(self) -> None:
        edits = rs.parse_refine_response('{"edits": [{"op": "create"}]}')
        assert edits == [{'op': 'create'}]

    def testFencedJson(self) -> None:
        text = 'Here you go:\n```json\n{"edits": [{"op": "delete", "id": "y"}]}\n```\nDone.'
        edits = rs.parse_refine_response(text)
        assert edits[0]['id'] == 'y'

    def testProseAroundJson(self) -> None:
        text = 'I propose {"edits": [{"op": "create", "kind": "memory"}]} as edits.'
        edits = rs.parse_refine_response(text)
        assert edits[0]['kind'] == 'memory'

    def testGarbageYieldsEmpty(self) -> None:
        assert rs.parse_refine_response('no json here') == []
        assert rs.parse_refine_response('') == []
        assert rs.parse_refine_response('{broken') == []

    def testNonDictItemsDropped(self) -> None:
        edits = rs.parse_refine_response('{"edits": [{"op": "create"}, "junk", 3]}')
        assert edits == [{'op': 'create'}]


# ---------------------------------------------------------------------------
# Prompt rendering
# ---------------------------------------------------------------------------


class TestRendering:
    def testRefinementsBlockOnlyPromptNotesAndMemory(self) -> None:
        _mk(content={'text': 'global note'})
        _mk(kind='memory', content={'text': 'memory note'})
        _mk(kind='skill', content={'name': 'sk', 'description': 'd'})
        _mk(scope='local', session_id='s9', content={'text': 'local note'})
        block = rs.render_refinements_block('s9')
        assert '<refinements>' in block
        assert 'local note' in block and 'global note' in block and 'memory note' in block
        assert 'sk' not in block  # skill entries are not prompt injections

    def testRefinementsBlockEmpty(self) -> None:
        assert rs.render_refinements_block('s1') == ''

    def testStateForRefineEmpty(self) -> None:
        assert 'empty' in rs.render_state_for_refine('s1')

    def testStateForRefineMarksGlobalReadOnly(self) -> None:
        _mk()
        _mk(scope='local', session_id='s1')
        state = rs.render_state_for_refine('s1')
        assert 'READ-ONLY (global)' in state
        assert 'editable' in state

    def testGlobalRefineStateExcludesLocalEntries(self) -> None:
        _mk(content={'text': 'global one'})
        _mk(scope='local', session_id='s1', content={'text': 'local one'})
        state = rs.render_state_for_refine('')
        assert 'global one' in state
        assert 'local one' not in state


# ---------------------------------------------------------------------------
# run_refine_pass (injectable producer)
# ---------------------------------------------------------------------------


def _producer(returning: str):
    async def llm(messages):
        assert messages[0]['role'] == 'system'
        return returning

    return llm


class TestRunRefinePass:
    @pytest.mark.asyncio
    async def testAppliesProducerEdits(self) -> None:
        payload = json.dumps({
            'edits': [{
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': 'from the pass'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            }]
        })
        result = await rs.run_refine_pass(evidence='ev', producer=_producer(payload))
        assert len(result['applied']) == 1
        assert result['applied'][0]['kind'] == 'prompt_note'
        assert not result['rejected']
        assert rs.list_entries()[0]['content'] == {'text': 'from the pass'}

    @pytest.mark.asyncio
    async def testLocalPassAppliesLocalAndRejectsGlobal(self) -> None:
        payload = json.dumps({
            'edits': [
                {
                    'op': 'create',
                    'kind': 'prompt_note',
                    'scope': 'local',
                    'content': {'text': 'session learn'},
                    'rationale': 'r',
                    'expectedOutcome': 'e',
                },
                {
                    'op': 'create',
                    'kind': 'prompt_note',
                    'scope': 'global',
                    'content': {'text': 'sneaky global'},
                    'rationale': 'r',
                    'expectedOutcome': 'e',
                },
            ]
        })
        result = await rs.run_refine_pass(
            session_id='s1', evidence='ev', producer=_producer(payload)
        )
        assert len(result['applied']) == 1
        assert result['applied'][0]['scope'] == 'local'
        assert len(result['rejected']) == 1
        entries = rs.list_entries(session_id='s1')
        assert len(entries) == 1
        assert entries[0]['sessionId'] == 's1'

    @pytest.mark.asyncio
    async def testUnparseableResponseAppliesNothing(self) -> None:
        result = await rs.run_refine_pass(evidence='ev', producer=_producer('sorry, no can do'))
        assert result['applied'] == [] and result['rejected'] == []
        assert 'error' not in result

    @pytest.mark.asyncio
    async def testProducerFailureIsReported(self) -> None:
        async def boom(messages):
            raise RuntimeError('upstream down')

        result = await rs.run_refine_pass(evidence='ev', producer=boom)
        assert result['applied'] == []
        assert 'upstream down' in result['error']

    @pytest.mark.asyncio
    async def testNoProducerFailsClosed(self, monkeypatch) -> None:
        monkeypatch.setattr(rs, '_resolve_producer', lambda: None)
        result = await rs.run_refine_pass(evidence='ev')
        assert 'no producer' in result['error']
        assert result['applied'] == []


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


class TestRefineConfig:
    def testDefaultOff(self) -> None:
        cfg = rs.get_refine_config()
        assert cfg == {'autoRefine': False, 'producerModel': '', 'reviewModel': ''}

    def testRoundTrip(self) -> None:
        result = rs.set_refine_config(
            {'autoRefine': True, 'producerModel': 'fast-model', 'reviewModel': 'cheap-model'}
        )
        assert result['ok']
        cfg = rs.get_refine_config()
        assert cfg['autoRefine'] is True
        assert cfg['producerModel'] == 'fast-model'
        assert cfg['reviewModel'] == 'cheap-model'


# ---------------------------------------------------------------------------
# auto_refine: gated by an independent cheap reviewer, discard-default
# ---------------------------------------------------------------------------


def _reviewer(answer: str):
    def factory(main_provider, hint=''):
        async def llm(messages):
            return answer

        return llm

    return factory


class TestAutoRefine:
    @pytest.mark.asyncio
    async def testDisabledByDefault(self) -> None:
        result = await rs.auto_refine(evidence='ev')
        assert result['status'] == 'disabled'

    @pytest.mark.asyncio
    async def testNoEvidenceSkips(self) -> None:
        rs.set_refine_config({'autoRefine': True})
        result = await rs.auto_refine(evidence='   ')
        assert result['status'] == 'skipped'

    @pytest.mark.asyncio
    async def testKeptBatchPersists(self, monkeypatch) -> None:
        rs.set_refine_config({'autoRefine': True, 'reviewModel': 'cheap-model'})
        monkeypatch.setattr(
            'app.services.workbench.providers.make_review_llm_client', _reviewer('KEEP')
        )
        payload = json.dumps({
            'edits': [{
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': 'keeper'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            }]
        })
        result = await rs.auto_refine(evidence='ev', producer=_producer(payload))
        assert result['status'] == 'kept'
        assert len(rs.list_entries()) == 1

    @pytest.mark.asyncio
    async def testDiscardedBatchRolledBack(self, monkeypatch) -> None:
        rs.set_refine_config({'autoRefine': True, 'reviewModel': 'cheap-model'})
        monkeypatch.setattr(
            'app.services.workbench.providers.make_review_llm_client', _reviewer('DISCARD')
        )
        payload = json.dumps({
            'edits': [{
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': 'will not survive'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            }]
        })
        result = await rs.auto_refine(evidence='ev', producer=_producer(payload))
        assert result['status'] == 'discarded'
        assert result['rolledBack']
        # The entry exists (append-only history) but is inactive.
        assert rs.list_entries() == []
        entry_id = result['rolledBack'][0]
        entry = rs.get_entry(entry_id)
        assert entry is not None and not rs.is_active(entry)
        assert rs.latest_version(entry)['op'] == 'delete'

    @pytest.mark.asyncio
    async def testSameModelAsProducerDiscards(self, monkeypatch) -> None:
        # Part 10 standing rule: the reviewer must be independent of the producer.
        rs.set_refine_config(
            {'autoRefine': True, 'producerModel': 'model-x', 'reviewModel': 'model-x'}
        )
        called = {'n': 0}

        def spy_factory(main_provider, hint=''):
            called['n'] += 1
            return _reviewer('KEEP')(main_provider, hint)

        monkeypatch.setattr(
            'app.services.workbench.providers.make_review_llm_client', spy_factory
        )
        payload = json.dumps({
            'edits': [{
                'op': 'create',
                'kind': 'memory',
                'scope': 'global',
                'content': {'text': 'judged by itself'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            }]
        })
        result = await rs.auto_refine(evidence='ev', producer=_producer(payload))
        assert result['status'] == 'discarded'
        assert 'same as the producer' in result['review']
        assert called['n'] == 0  # reviewer never even consulted

    @pytest.mark.asyncio
    async def testMissingReviewerDiscards(self, monkeypatch) -> None:
        rs.set_refine_config({'autoRefine': True, 'reviewModel': 'cheap-model'})
        monkeypatch.setattr(
            'app.services.workbench.providers.make_review_llm_client',
            lambda main_provider, hint='': None,
        )
        payload = json.dumps({
            'edits': [{
                'op': 'create',
                'kind': 'prompt_note',
                'scope': 'global',
                'content': {'text': 'unreviewed'},
                'rationale': 'r',
                'expectedOutcome': 'e',
            }]
        })
        result = await rs.auto_refine(evidence='ev', producer=_producer(payload))
        assert result['status'] == 'discarded'
        assert 'no reviewer' in result['review']

    @pytest.mark.asyncio
    async def testNoEditsShortCircuits(self, monkeypatch) -> None:
        rs.set_refine_config({'autoRefine': True, 'reviewModel': 'cheap-model'})
        result = await rs.auto_refine(
            evidence='ev', producer=_producer('{"edits": []}')
        )
        assert result['status'] == 'no-edits'


# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------


class TestRefineApi:
    @pytest.mark.asyncio
    async def testEntryLifecycleOverHttp(self) -> None:
        from app.routers.refine_store import router
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient

        app = FastAPI()
        app.include_router(router)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as client:
            # Create (camelCase boundary).
            resp = await client.post(
                '/api/harness/refine/entries',
                json={
                    'kind': 'prompt_note',
                    'scope': 'global',
                    'content': {'text': 'api note'},
                    'rationale': 'r',
                    'expectedOutcome': 'e',
                },
            )
            assert resp.status_code == 200, resp.text
            entry_id = resp.json()['entry']['id']

            # List.
            resp = await client.get('/api/harness/refine/entries')
            assert any(e['id'] == entry_id for e in resp.json()['entries'])

            # Update.
            resp = await client.put(
                f'/api/harness/refine/entries/{entry_id}',
                json={'content': {'text': 'v2'}, 'rationale': 'r2', 'expectedOutcome': 'e2'},
            )
            assert resp.status_code == 200
            assert resp.json()['entry']['versions'][-1]['content'] == {'text': 'v2'}

            # Rollback.
            resp = await client.post(
                f'/api/harness/refine/entries/{entry_id}/rollback', json={}
            )
            assert resp.status_code == 200
            assert resp.json()['entry']['versions'][-1]['content'] == {'text': 'api note'}

            # Delete.
            resp = await client.request(
                'DELETE',
                f'/api/harness/refine/entries/{entry_id}',
                json={'rationale': 'done', 'expectedOutcome': 'clean'},
            )
            assert resp.status_code == 200
            assert resp.json()['entry']['versions'][-1]['op'] == 'delete'

            # 404 for unknown.
            resp = await client.get('/api/harness/refine/entries/ref_prompt_note_ghost')
            assert resp.status_code == 404

    @pytest.mark.asyncio
    async def testInvalidCreateRejected(self) -> None:
        from app.routers.refine_store import router
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient

        app = FastAPI()
        app.include_router(router)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as client:
            resp = await client.post(
                '/api/harness/refine/entries',
                json={
                    'kind': 'prompt_note',
                    'scope': 'global',
                    'content': {},
                    'rationale': 'r',
                    'expectedOutcome': 'e',
                },
            )
            assert resp.status_code == 400

    @pytest.mark.asyncio
    async def testConfigOverHttp(self) -> None:
        from app.routers.refine_store import router
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient

        app = FastAPI()
        app.include_router(router)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as client:
            resp = await client.get('/api/harness/refine/config')
            assert resp.json()['refineConfig']['autoRefine'] is False
            resp = await client.put(
                '/api/harness/refine/config',
                json={'autoRefine': True, 'producerModel': 'p', 'reviewModel': 'r'},
            )
            assert resp.status_code == 200
            resp = await client.get('/api/harness/refine/config')
            assert resp.json()['refineConfig']['autoRefine'] is True

    @pytest.mark.asyncio
    async def testAutoEndpointDisabledByDefault(self) -> None:
        from app.routers.refine_store import router
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient

        app = FastAPI()
        app.include_router(router)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as client:
            resp = await client.post(
                '/api/harness/refine/auto', json={'evidence': 'something happened'}
            )
            assert resp.status_code == 200
            assert resp.json()['status'] == 'disabled'


# ---------------------------------------------------------------------------
# System-prompt injection (additive block, never the base prompt)
# ---------------------------------------------------------------------------


class TestSystemPromptInjection:
    def testRefinementsReachBuildSystemPrompt(self) -> None:
        from app.services.workbench.workbench import buildSystemPrompt, createWorkbenchSession

        session = createWorkbenchSession(guardMode='full')
        # No entries → no block.
        assert '<refinements>' not in buildSystemPrompt(session)
        # A local prompt_note for THIS session appears as an added block.
        _mk(scope='local', session_id=session.id, content={'text': 'always run ruff first'})
        prompt = buildSystemPrompt(session)
        assert '<refinements>' in prompt
        assert 'always run ruff first' in prompt
        # The base system prompt is intact — the block is additive.
        assert 'August' in prompt

    def testOtherSessionLocalNotesDoNotLeak(self) -> None:
        from app.services.workbench.workbench import buildSystemPrompt, createWorkbenchSession

        session = createWorkbenchSession(guardMode='full')
        _mk(scope='local', session_id='some-other-session', content={'text': 'private note'})
        assert 'private note' not in buildSystemPrompt(session)
