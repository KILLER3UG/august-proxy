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
