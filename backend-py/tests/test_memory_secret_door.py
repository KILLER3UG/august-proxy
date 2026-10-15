"""A credential must not become a durable fact.

`save_fact` is the one door every model- and human-initiated fact write goes
through, and whatever is stored there is re-injected into later turns by the
<memory> tail and the always-in profile lane. Storing a key is therefore not
"remembering" it — it is publishing it onward to every provider request, and
into any session that unions the row's scope.
"""

from __future__ import annotations

import pytest
from app.services import memory_store

# Shape-only: a syntactically valid-looking OpenAI key, not a real one.
SECRET_VALUE = 'the project key is sk-abcdefghijklmnopqrstuvwxyz012345'


def test_save_fact_refuses_a_secret_shaped_value() -> None:
    with pytest.raises(ValueError, match='secret-shaped'):
        memory_store.save_fact('k_leaked_key', SECRET_VALUE, title='deploy key')

    assert memory_store.get_fact('k_leaked_key') is None


def test_save_fact_refuses_a_secret_in_the_description_too() -> None:
    with pytest.raises(ValueError, match='secret-shaped'):
        memory_store.save_fact(
            'k_leaked_desc',
            'prefers pytest',
            description='token ghp_' + 'A' * 36,
        )


def test_save_fact_still_accepts_ordinary_content() -> None:
    memory_store.save_fact('k_ordinary', 'Prefers `pytest -n auto` on this box.', title='test runner')
    row = memory_store.get_fact('k_ordinary')
    assert row is not None
    assert 'pytest' in str(row.get('factValue'))  # wire shape, JSON-encoded as stored


def test_the_refusal_never_echoes_the_secret() -> None:
    try:
        memory_store.save_fact('k_no_echo', SECRET_VALUE, title='key')
    except ValueError as exc:
        assert 'sk-abcdefghijklmnopqrstuvwxyz012345' not in str(exc)
    else:  # pragma: no cover - the refusal above must fire
        pytest.fail('expected the secret-shaped refusal')


# A judge verdict that names the key it learned about, in the shape the distiller
# actually receives. Shape-only again — no live credential is anywhere in this file.
LEAKY_VERDICT = (
    'The staging Anthropic key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 '
    'and it works against the proxy base URL.'
)
DURABLE_VERDICT = (
    'Read Quartus fmax from the .sdc.rpt file, because stdout truncates the worst slack path.'
)


def test_a_refused_lesson_costs_one_verdict_not_the_whole_batch() -> None:
    """`apply_verdict` must swallow the door's refusal, because both batch callers
    loop over verdicts with no try/except of their own.

    A raise here dropped every later lesson in the batch AND skipped the state
    each loop writes after applying — the review pass's `_setReviewCursor`, the
    episode pass's `set_judge_verdict` — so the same window stayed unreviewed and
    was re-read, re-crashing, on every future pass. Found by `scripts/harness_eval.py`.
    """
    from app.services import skill_distiller as sd

    labels = [
        sd.apply_verdict({'episode': 1, 'action': 'memory', 'summary': LEAKY_VERDICT}, 'user-correction:batch'),
        sd.apply_verdict({'episode': 2, 'action': 'memory', 'summary': DURABLE_VERDICT}, 'user-correction:batch'),
    ]
    assert labels == ['rejected-write-door', 'memory-saved']

    rows = memory_store.list_facts()
    assert len(rows) == 1, 'the refused verdict must not take the durable lesson down with it'
    assert 'Quartus' in str(rows[0].get('factValue'))


def test_a_refused_promotion_names_the_door_not_the_generic_failure(tmp_path) -> None:
    """The applier's function-wide `except Exception` already returned
    ``{'ok': False}``, so this is not a crash fix — it is the readout.

    `promotion failed: <raw>` is the bucket an absent workspace, a broken skill
    read and a refused credential all land in. On the inbox row a human decides
    from, "the store refuses this content" and "the applier broke" have to look
    different.
    """
    from app.services.harness_promote import apply_promotion

    result = apply_promotion(
        {
            'promoteType': 'fact',
            'title': 'staging anthropic key sk-abcdefghijklmnopqrstuvwxyz012345',
            'workspaces': [str(tmp_path)],
        }
    )
    assert result['ok'] is False
    assert str(result.get('error', '')).startswith('stores refused the write')
    assert 'sk-abcdefghijklmnopqrstuvwxyz012345' not in str(result.get('error', ''))
    assert memory_store.list_facts() == []
