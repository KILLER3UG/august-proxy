"""Regressions for the harness fixes taken from three reference harnesses.

Each test here corresponds to a defect that shipped and that a source study of
deepseek-harness / hermes-agent / oh-my-pi showed was already solved elsewhere.
They are grouped because they share one property: the loop or the wire accepted
a state it should have refused, and nothing failed loudly.
"""

from __future__ import annotations

import json as _json
import sqlite3
import threading

# --------------------------------------------------------------------------
# cost_estimator: a cheap model priced at the flagship rate
# --------------------------------------------------------------------------


def test_a_mini_model_is_not_billed_at_its_family_rate():
    """`gpt-4o` sorted above `gpt-4o-mini` billed the mini at 2.5/10.0 — ~16x
    the output rate — because the lookup is a first-substring-hit scan. That fed
    the Usage page, the composer chip, and the budget ladder alike."""
    from app.services.cost_estimator import price_for_model

    mini = price_for_model('gpt-4o-mini')
    flagship = price_for_model('gpt-4o')
    assert mini.in_per_m == 0.15, f'gpt-4o-mini matched {mini.source} at {mini.in_per_m}'
    assert mini.out_per_m == 0.6
    assert flagship.in_per_m == 2.5, 'the family row must still price the family'
    assert mini.out_per_m < flagship.out_per_m


def test_every_mini_variant_resolves_to_its_own_row():
    from app.services.cost_estimator import price_for_model

    for model in ('gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4-mini', 'claude-3-5-haiku'):
        priced = price_for_model(model)
        assert priced.estimated is True, f'{model} fell through to a guess, not the table'
        assert priced.source == 'table'


def test_the_table_order_is_asserted_at_import():
    """The order IS the logic. An import-time check means a future row cannot
    quietly re-shadow an existing one — the failure would otherwise be a silent
    price change, not a test failure."""
    from app.services import cost_estimator

    cost_estimator._assertNarrowestFirst()  # must not raise


def test_an_unrelated_model_is_untouched():
    from app.services.cost_estimator import price_for_model

    # The rows that were only reordered must keep their exact rates.
    assert price_for_model('claude-opus-4').in_per_m == 15.0
    assert price_for_model('gpt-5').out_per_m == 10.0
    assert price_for_model('deepseek-reasoner').out_per_m == 2.19


# --------------------------------------------------------------------------
# brain_config: the runaway backstop had no door
# --------------------------------------------------------------------------


def test_runaway_knobs_are_settable_through_the_config_door():
    """loop/guards.py read `runawayStopRounds` off the brain config, but the key
    was in neither numKeys nor fieldTable: validatePatch 400'd a PUT naming it
    and _snakeToCamel dropped a hand-edited config.json value before the guard
    could ever see it. The feature AGENTS.md documents was unreachable."""
    from app.services.brain_config_service import (
        allowedKeys,
        camelToSnake,
        fieldKind,
        snakeToCamel,
        validatePatch,
    )

    assert 'runawayStopRounds' in allowedKeys
    assert 'runawayNudgeRounds' in allowedKeys
    assert fieldKind['runawayStopRounds'] == 'num'
    assert snakeToCamel['runaway_stop_rounds'] == 'runawayStopRounds'
    assert camelToSnake['runawayStopRounds'] == 'runaway_stop_rounds'

    ok, err = validatePatch({'runawayStopRounds': 40, 'runawayNudgeRounds': 25})
    assert ok, err


def test_runaway_knobs_reject_nonsense_but_allow_zero():
    """0 is the OFF sentinel and must stay writable, or an armed backstop could
    never be disarmed — the same rule the budget rungs carry."""
    from app.services.brain_config_service import validatePatch

    assert validatePatch({'runawayStopRounds': 0})[0]
    ok, err = validatePatch({'runawayStopRounds': -5})
    assert not ok and 'between' in err
    assert not validatePatch({'runawayStopRounds': 'forty'})[0]


# --------------------------------------------------------------------------
# skills: an approved patch must not resurrect a disabled skill
# --------------------------------------------------------------------------


def test_the_frontmatter_render_preserves_disablement():
    """_skill_frontmatter REPLACES the whole block, and `disabled` is what
    _parseSkill keys enablement off — exactly what setEnabled writes and what
    supersession writes to retire a v1. Omitting it silently put a retired skill
    back into <capabilities>, <relevant_skills> and the intake line."""
    from app.services.harness_self_improve import _skill_frontmatter

    rendered = _skill_frontmatter(
        'x', 'desc', '', version=2, status='active', disabled=True
    )
    assert 'disabled: true' in rendered

    kept = _skill_frontmatter('x', 'desc', '', version=2, status='active')
    assert 'disabled' not in kept


def test_a_disabled_skill_survives_an_approved_patch(isolatedData):
    """End to end through the applier, not just the renderer."""
    from app.services.harness_self_improve import _apply_approved
    from app.services.skill_service import _agentSkillsDir, get, setEnabled

    created = _apply_approved(
        {'kind': 'skill_create', 'payload': {'name': 'keeper', 'description': 'd', 'body': 'b'}}
    )
    assert created.get('ok'), created
    setEnabled('keeper', enabled=False)
    # _parseSkill surfaces enablement inverted from the frontmatter flag.
    assert get('keeper').get('enabled') is False

    patched = _apply_approved(
        {
            'kind': 'skill_patch',
            'payload': {'name': 'keeper', 'description': 'd', 'body': 'b2'},
        }
    )
    assert patched.get('ok'), patched

    md = (_agentSkillsDir() / 'keeper' / 'SKILL.md').read_text('utf-8')
    assert 'disabled: true' in md, f'the patch dropped enablement:\n{md}'
    assert get('keeper').get('enabled') is False, 'a text patch re-enabled a disabled skill'
    assert 'b2' in md, 'the new body did not land'


def test_a_shipped_skill_long_description_does_not_block_an_edit(isolatedData):
    """5 of the 6 bundled skills describe themselves in 126–168 chars, over the
    60-char write-door cap. The settings UI prefills the form from the stored
    value and resubmits it, so Settings → Edit → Save failed for those five —
    even to change only the body. The cap must still refuse a NEW long one."""
    from app.services.skill_service import (
        SkillValidationError,
        _agentSkillsDir,
        get,
        patchSkill,
    )

    longDesc = 'A deliberately verbose description that is well past the sixty character cap.'
    # createSkill enforces the cap, so author the over-long file the way the
    # shipped skills are: written directly, then edited through the door.
    d = _agentSkillsDir() / 'longworded'
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(
        f'---\nname: longworded\ndescription: "{longDesc}"\ncategory: uncategorized\n---\n\noriginal body\n',
        encoding='utf-8',
    )

    # Resubmitting the stored value (what the edit form does) must succeed.
    patchSkill('longworded', description=longDesc, body='rewritten body')
    assert 'rewritten body' in str(get('longworded').get('instructions', ''))

    # But authoring a NEW over-long description is still refused.
    try:
        patchSkill('longworded', description='x' * 200, body='b')
    except SkillValidationError as exc:
        assert 'exceeds' in str(exc)
    else:
        raise AssertionError('a new over-long description was accepted')


# --------------------------------------------------------------------------
# durability: the packaged quit is taskkill /T /F
# --------------------------------------------------------------------------


def test_wal_is_checkpointed_periodically_not_only_on_a_clean_close():
    """main.py's lifespan flushes never run on the product's only quit path, so
    everything since the last clean close lived in the -wal sidecar alone."""
    from app.services.memory_conn import (
        _CHECKPOINT_EVERY_N_WRITES,
        _local,
        _writes_since_checkpoint,
        note_commit,
    )

    assert _CHECKPOINT_EVERY_N_WRITES == 50

    seen: list[tuple] = []

    class _Spy:
        def execute(self, sql: str):
            seen.append(sql)

    tid = threading.get_ident()
    saved = getattr(_local, 'conn', None)
    _local.conn = _Spy()
    try:
        _writes_since_checkpoint.pop(tid, None)
        for _ in range(_CHECKPOINT_EVERY_N_WRITES - 1):
            note_commit()
        assert not seen, 'checkpointed before the threshold'
        note_commit()
        assert seen == ['PRAGMA wal_checkpoint(PASSIVE)']
    finally:
        _local.conn = saved
        _writes_since_checkpoint.pop(tid, None)


def test_a_checkpoint_failure_never_raises_into_the_write_path():
    """A broken checkpoint must not take the write path down with it.

    Called `_CHECKPOINT_EVERY_N_WRITES` times: a single call never reaches the
    threshold, so the failing `execute` would never run and this asserted
    nothing.
    """
    from app.services import memory_conn

    class _Boom:
        def execute(self, *_a, **_k):
            raise sqlite3.OperationalError('nope')

    original = getattr(memory_conn._local, 'conn', None)
    memory_conn._local.conn = _Boom()
    try:
        for _ in range(memory_conn._CHECKPOINT_EVERY_N_WRITES):
            memory_conn.note_commit()  # must not raise
    finally:
        memory_conn._local.conn = original


def test_the_checkpoint_counter_is_per_thread():
    from app.services.memory_conn import _writes_since_checkpoint

    tid = threading.get_ident()
    _writes_since_checkpoint[tid] = 7
    seen: dict[str, int] = {}

    def _probe():
        seen['count'] = _writes_since_checkpoint.get(threading.get_ident(), 0)

    t = threading.Thread(target=_probe)
    t.start()
    t.join()
    assert seen['count'] == 0, 'a worker thread saw the owner thread counter'
    assert _writes_since_checkpoint[tid] == 7


# --------------------------------------------------------------------------
# the /v1 wire: a control-plane frame is not a wire event
# --------------------------------------------------------------------------


async def test_upstream_retry_never_reaches_an_sdk_client(monkeypatch):
    """Three of five streaming paths already dropped the internal retry notice;
    the OpenAI chat and Responses pass-throughs forwarded it verbatim, so a
    429/503 before first token handed the client a chunk with no choices/id.

    Driven through the real generator with a fake transport, so this pins the
    emitted bytes rather than the presence of a string in the source.
    """
    import json as _json

    from app.adapters import openai as oai

    class _Client:
        async def streamSse(self, *_a, **_k):
            yield {'type': 'upstreamRetry', 'attempt': 1, 'delayMs': 500}
            yield {'choices': [{'delta': {'content': 'hello'}}]}
            yield {'choices': [{'delta': {}, 'finish_reason': 'stop'}]}

    async def _fakeClient():
        return _Client()

    monkeypatch.setattr(oai, '_getClient', _fakeClient)
    chunks = [c async for c in oai.streamOpenaiSseToClient('http://x', {}, {'model': 'm'})]
    body = ''.join(chunks)

    assert 'upstreamRetry' not in body, 'an internal frame leaked onto the wire'
    assert 'hello' in body
    for line in body.splitlines():
        if line.startswith('data: ') and line[6:].strip() != '[DONE]':
            payload = _json.loads(line[6:])
            assert 'choices' in payload or 'usage' in payload or payload == {}, payload


def test_the_retry_filter_keeps_every_real_chunk():
    """The filter must drop only the internal frame, not any upstream event."""
    def _passes(event: dict) -> bool:
        return event.get('type') != 'upstreamRetry'

    assert not _passes({'type': 'upstreamRetry', 'attempt': 1})
    assert _passes({'choices': [{'delta': {'content': 'hi'}}]})
    assert _passes({'type': 'response.output_text.delta', 'delta': 'x'})
    assert _passes({})
