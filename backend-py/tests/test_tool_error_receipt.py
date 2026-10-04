"""The structured tool-error receipt (Pass 1 item 1).

Tool failures must be recognised from what the harness *recorded*, never from
prose that happens to look like an error. The old detector searched
``[Validation Error]`` / ``traceback`` / ``exit code:N`` anywhere in assistant
and tool text — so a tool result that merely *quoted* one of those strings
(eight of August's own skills document the error-vocabulary table) mined as a
failure. Measured on the dev database: 41/41 episodes carried ``tool_error``
and none carried a real failure.

The receipt already exists upstream: ``tool_protocol.normalize_tool_result``
is the single choke point every tool result passes through, and the UI's
``MessageTool.status`` is already ``'running' | 'done' | 'error'``. These tests
pin the missing links — is_error is total at the choke point, it survives into
``blocks_json``, and the miner reads only that.
"""

from __future__ import annotations

import json

import pytest
from app.services import episode_miner as em
from app.services.memory_store import transcript_blocks as tb
from app.services.workbench.tool_protocol import (
    ERROR_RECEIPT_PREFIXES,
    RECEIPT_TONE,
    SYNTHETIC_TOOL_RESULT_PREFIX,
    normalize_tool_result,
    receipt_tone,
    reconcile_tool_results,
    synthetic_tool_result,
    tool_result_failed,
)

# Verbatim content of August's own skill documentation
# (skills/august-harness/SKILL.md), which lists the error vocabulary it must
# recognise. A tool result that read this file is the exact false positive that
# produced all 41 bogus episodes.
SKILL_DOC_TEXT = (
    '## Error families\n'
    '`[Validation Error]` means the arguments were malformed.\n'
    'A `traceback` or `exit code:1` means the command failed.\n'
    'The harness reports `tool failed` when a worker errored.\n'
)


@pytest.fixture
def brain(isolatedData):
    return isolatedData


def _seed(sessionId: str, msgs: list[tuple[str, object]]) -> None:
    """Seed messages the way ``save_workbench_blob`` does: content plus the
    derived ``blocks_json`` the real write path would have produced."""
    from app.services.memory_store import init
    from app.services.memory_store.transcript_blocks import encode_blocks

    init()
    from app.services.memory_conn import conn

    c = conn()
    c.execute('INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)', (sessionId, 't'))
    for role, payload in msgs:
        msg = dict(payload) if isinstance(payload, dict) else {'role': role, 'content': payload}
        msg.setdefault('role', role)
        content = msg.get('content', '')
        content_str = (
            content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        )
        c.execute(
            'INSERT INTO messages (session_id, role, content, blocks_json) VALUES (?, ?, ?, ?)',
            (sessionId, role, content_str, encode_blocks(msg)),
        )
    c.commit()


class TestReceiptIsTotal:
    """Every tool result leaves the choke point with a decided is_error."""

    def test_a_plain_result_is_explicitly_not_an_error(self):
        out = normalize_tool_result({'role': 'tool', 'tool_use_id': 't1', 'content': 'ok'})
        assert out['is_error'] is False

    def test_an_empty_result_is_an_error(self):
        out = normalize_tool_result({'role': 'tool', 'tool_use_id': 't1', 'content': '   '})
        assert out['is_error'] is True

    def test_a_non_text_payload_that_produced_nothing_is_an_error(self):
        out = normalize_tool_result({'role': 'tool', 'tool_use_id': 't1', 'content': None})
        assert out['is_error'] is True

    def test_quoting_error_vocabulary_does_not_set_the_flag(self):
        """The regression this whole item exists for."""
        out = normalize_tool_result(
            {'role': 'tool', 'tool_use_id': 't1', 'name': 'read_file', 'content': SKILL_DOC_TEXT}
        )
        assert out['is_error'] is False

    def test_a_declared_failure_survives_normalization(self):
        out = normalize_tool_result(
            {'role': 'tool', 'tool_use_id': 't1', 'content': 'Error: no such file', 'is_error': True}
        )
        assert out['is_error'] is True

    def test_reconciliation_leaves_no_result_undecided(self):
        """Totality: the list that enters the transcript is all decided bools."""
        closed = reconcile_tool_results(
            [('t1', 'read_file'), ('t2', 'run_command')],
            [{'role': 'tool', 'tool_use_id': 't1', 'content': SKILL_DOC_TEXT}],
        )
        assert [r['tool_use_id'] for r in closed.results] == ['t1', 't2']
        assert all(isinstance(r.get('is_error'), bool) for r in closed.results)
        assert closed.results[1]['is_error'] is True  # synthesized — never ran


class TestReceiptClassificationIsOneRule:
    """The UI status and the durable flag come from the same predicate."""

    @pytest.mark.parametrize(
        'text',
        [
            'Error: no such file',
            '[Validation Error] Tool X received malformed JSON arguments:',
            '[Blocked] write outside the workspace',
            '[Tool result missing] ' + "'run_command' did not return a result.",
        ],
    )
    def test_the_harness_writes_each_of_these_itself(self, text):
        assert tool_result_failed(text) is True

    @pytest.mark.parametrize(
        'text',
        [
            '',
            'all good',
            'The run hit an Error: in its second line but completed.',
            SKILL_DOC_TEXT,
        ],
    )
    def test_only_a_prefix_counts(self, text):
        """Anchoring is the fix: the same words anywhere else in a receipt are
        content the tool returned, not the tool's own verdict."""
        assert tool_result_failed(text) is False

    def test_a_result_declaring_itself_failed_is_recorded_without_a_hint(self):
        out = normalize_tool_result(
            {'role': 'tool', 'tool_use_id': 't1', 'content': 'Error: permission denied'}
        )
        assert out['is_error'] is True

    def test_a_guard_denial_is_recorded_as_a_failure(self):
        out = normalize_tool_result({'role': 'tool', 'tool_use_id': 't1', 'content': '[Blocked] nope'})
        assert out['is_error'] is True


class TestReceiptSurvivesPersistence:
    """``is_error`` reaches ``blocks_json`` in the UI's own vocabulary."""

    def test_a_failed_tool_message_persists_status_error(self):
        blocks = tb.derive_blocks(
            {'role': 'tool', 'tool_use_id': 't1', 'name': 'run_command', 'content': 'boom', 'is_error': True}
        )
        assert blocks[0]['tool']['status'] == 'error'

    def test_a_clean_tool_message_still_persists_done(self):
        blocks = tb.derive_blocks(
            {'role': 'tool', 'tool_use_id': 't1', 'name': 'run_command', 'content': 'fine'}
        )
        assert blocks[0]['tool']['status'] == 'done'

    def test_an_anthropic_tool_result_block_carries_its_own_flag(self):
        blocks = tb.derive_blocks(
            {
                'role': 'user',
                'content': [
                    {'type': 'tool_result', 'tool_use_id': 't1', 'content': 'denied', 'is_error': True}
                ],
            }
        )
        assert blocks[0]['tool']['status'] == 'error'

    def test_the_error_status_round_trips_through_the_allow_list(self):
        """Enrichment must not sanitize the receipt away — a dropped status
        would silently restore the false-positive blindness."""
        encoded = tb.sanitize_enrichment(
            blocks=[
                {
                    'id': 't1',
                    'type': 'toolCall',
                    'content': 'boom',
                    'tool': {'id': 't1', 'name': 'run_command', 'status': 'error'},
                }
            ]
        )
        assert encoded['blocks'][0]['tool']['status'] == 'error'


class TestMinerReadsOnlyTheReceipt:
    def test_a_real_failure_mines_an_episode(self, brain):
        _seed(
            's1',
            [
                ('user', 'run the build'),
                (
                    'tool',
                    {
                        'role': 'tool',
                        'tool_use_id': 't1',
                        'name': 'run_command',
                        'content': 'Error: build failed',
                        'is_error': True,
                    },
                ),
                ('assistant', 'Fixed the include path — the build passes now.'),
            ],
        )
        fr = [e for e in em.extract_episodes('s1') if e['kind'] == 'failure_recovery']
        assert len(fr) == 1
        assert fr[0]['events'][0]['type'] == 'tool_error'
        assert fr[0]['outcome'] == 'resolved'

    def test_quoted_error_vocabulary_mines_nothing(self, brain):
        """The 41 false positives, pinned shut."""
        _seed(
            's2',
            [
                ('user', 'what error families does the harness use?'),
                (
                    'tool',
                    {
                        'role': 'tool',
                        'tool_use_id': 't1',
                        'name': 'read_file',
                        'content': SKILL_DOC_TEXT,
                    },
                ),
                ('assistant', 'It groups them into eight families.'),
            ],
        )
        assert em.extract_episodes('s2') == []

    def test_assistant_prose_naming_an_error_mines_nothing(self, brain):
        _seed(
            's3',
            [
                ('assistant', 'I saw a traceback earlier, so let me explain [Validation Error].'),
                ('assistant', 'Nothing actually failed — that was the plan, not a result.'),
            ],
        )
        assert em.extract_episodes('s3') == []

    def test_a_pre_receipt_row_is_not_reinvented_from_text(self, brain):
        """Legacy rows have no receipt. They must mine nothing rather than
        fall back to prose — the fallback is what produced the 41/41."""
        from app.services.memory_store import init

        init()
        from app.services.memory_conn import conn

        c = conn()
        c.execute("INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)", ('s4', 't'))
        c.execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            ('s4', 'tool', json.dumps({'content': SKILL_DOC_TEXT})),
        )
        c.commit()
        assert em.extract_episodes('s4') == []

    def test_synthetic_not_executed_receipt_mines_an_episode(self, brain):
        receipt = synthetic_tool_result('t1', 'run_command', 'round cancelled')
        _seed('s5', [('user', 'go'), ('tool', receipt), ('assistant', 'Re-ran it, worked.')])
        fr = [e for e in em.extract_episodes('s5') if e['kind'] == 'failure_recovery']
        assert len(fr) == 1


class TestReceiptToneIsOneMap:
    """Decision: the receipt stays honest, the TONE is chosen at render.

    Red for genuine failures, muted for a guardrail denial or a call that never
    ran — but `is_error` stays true for both, because the call did not succeed
    and mining must keep seeing that.
    """

    def test_each_marker_gets_its_declared_tone(self):
        assert receipt_tone('Error: build failed') == 'failure'
        assert receipt_tone('[Validation Error] Tool X received malformed') == 'failure'
        assert receipt_tone('[Blocked] outside the workspace') == 'denial'
        assert receipt_tone('[Tool result missing] did not return a result') == 'denial'

    def test_a_clean_receipt_is_not_tinted_as_a_failure(self):
        assert receipt_tone('all good') == 'none'

    def test_every_prefix_has_a_tone_and_no_tone_invents_a_prefix(self):
        """The drift guard.

        A new marker added to the prefix list without a tone decision would
        otherwise fall through to the red branch silently — the exact mistake
        this map exists to prevent, and the reason tone is derived from the map
        rather than written as a second list beside it.
        """
        assert ERROR_RECEIPT_PREFIXES == tuple(RECEIPT_TONE)
        assert set(RECEIPT_TONE.values()) <= {'failure', 'denial'}
        assert [p for p, t in RECEIPT_TONE.items() if t == 'denial'] == [
            '[Blocked]',
            SYNTHETIC_TOOL_RESULT_PREFIX,
        ]

    def test_a_prefix_added_to_the_tuple_alone_breaks_the_guard(self):
        """Prove the guard bites instead of trusting it."""
        import app.services.workbench.tool_protocol as tp

        original = tp.ERROR_RECEIPT_PREFIXES
        try:
            tp.ERROR_RECEIPT_PREFIXES = original + ('[NewMarker]',)
            with pytest.raises(AssertionError):
                assert tp.ERROR_RECEIPT_PREFIXES == tuple(tp.RECEIPT_TONE)
        finally:
            tp.ERROR_RECEIPT_PREFIXES = original


class TestToneNeverWeakensTheReceipt:
    """The muted markers are still recorded as failures."""

    @pytest.mark.parametrize(
        'content',
        ['[Blocked] outside the workspace', '[Tool result missing] never returned'],
    )
    def test_is_error_stays_true_for_a_denial(self, content):
        assert normalize_tool_result({'role': 'tool', 'tool_use_id': 't1', 'content': content})[
            'is_error'
        ] is True

    def test_a_denial_persists_as_an_error_receipt_not_a_quiet_status(self, brain):
        """Status is the mining contract; tone is display metadata beside it.

        If tone ever replaced status, the quarantine sweep and the episode
        detector would stop seeing guardrail denials — a silent change to the
        signal that took this pass to fix.
        """
        from app.services.workbench.tool_protocol import normalize_tool_result

        msg = normalize_tool_result(
            {'role': 'tool', 'tool_use_id': 't1', 'name': 'write_file', 'content': '[Blocked] nope'}
        )
        assert receipt_tone(msg['content']) == 'denial'
        blocks = tb.derive_blocks(msg)
        assert blocks[0]['tool']['status'] == 'error'
        assert blocks[0]['tool']['tone'] == 'denial'
        assert _errorReceiptStatus(blocks) == 'error'

    def test_the_tone_survives_the_enrichment_allow_list(self):
        """A dropped key would silently restore the all-red rendering."""
        encoded = tb.sanitize_enrichment(
            blocks=[
                {
                    'id': 't1',
                    'type': 'toolCall',
                    'content': '[Blocked] nope',
                    'tool': {'id': 't1', 'name': 'write_file', 'status': 'error', 'tone': 'denial'},
                }
            ]
        )
        assert encoded['blocks'][0]['tool']['tone'] == 'denial'


def _errorReceiptStatus(blocks: list[dict]) -> str:
    """What the miner reads — same path as ``episode_miner._errorReceipts``."""
    from app.services.episode_miner import _errorReceipts

    tool = blocks[0]['tool']
    assert tool['status'] == 'error'
    return tool['status']


class TestEndToEndThroughTheRealSavePath:
    """Write through ``save_workbench_session_sot`` (the durability barrier the
    loop actually calls) and read the mined result back — the whole chain, not
    each link in isolation."""

    def _save(self, sid: str, receipt: dict) -> None:
        from app.services.memory_store import init
        from app.services.memory_store.sessions import save_workbench_session_sot

        init()
        save_workbench_session_sot(
            {'id': sid, 'title': 't'},
            [
                {'role': 'user', 'content': 'run it'},
                {'role': 'assistant', 'content': 'Calling the tool.', 'tool_calls': []},
                receipt,
                {'role': 'assistant', 'content': 'Retried with the right path — it passes now.'},
            ],
        )

    def _rows(self, sid: str) -> list[tuple[str, object]]:
        from app.services.memory_conn import conn

        return [
            (str(r['role']), r['blocks_json'])
            for r in conn().execute(
                'SELECT role, blocks_json FROM messages WHERE session_id = ? ORDER BY id', (sid,)
            ).fetchall()
        ]

    def test_a_failed_call_reaches_storage_and_mines_one_episode(self, brain):
        from app.services.workbench.tool_protocol import normalize_tool_result

        self._save(
            'e1',
            normalize_tool_result(
                {'role': 'tool', 'tool_use_id': 't1', 'content': 'Error: path missing'},
                tool_name='read_file',
            ),
        )
        toolRows = [b for r, b in self._rows('e1') if r == 'tool']
        assert len(toolRows) == 1
        assert json.loads(toolRows[0])['blocks'][0]['tool']['status'] == 'error'
        fr = [e for e in em.extract_episodes('e1') if e['kind'] == 'failure_recovery']
        assert len(fr) == 1 and fr[0]['outcome'] == 'resolved'

    def test_a_quoted_error_document_reaches_storage_and_mines_nothing(self, brain):
        """The exact shape of the 41 bogus episodes, through the real writer."""
        from app.services.workbench.tool_protocol import normalize_tool_result

        self._save(
            'e2',
            normalize_tool_result(
                {'role': 'tool', 'tool_use_id': 't1', 'content': SKILL_DOC_TEXT},
                tool_name='read_file',
            ),
        )
        toolRows = [b for r, b in self._rows('e2') if r == 'tool']
        assert json.loads(toolRows[0])['blocks'][0]['tool']['status'] == 'done'
        assert em.extract_episodes('e2') == []

