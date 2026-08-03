"""Secret scan on memory write paths."""

from __future__ import annotations

import pytest


@pytest.fixture()
def brain_ready(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.services.memory_schema import ensure_schema
    from app.services.memory_store import _conn

    c = _conn()
    ensure_schema(c)
    c.commit()
    return c


OPENAI_SECRET = 'sk-abcdefghijklmnopqrstuvwxyz1234567890'
ANTHROPIC_SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890'


def test_scrubber_detects_patterns():
    from app.services.memory.memory_scrubber import find_secrets, refuse_reason

    assert find_secrets(f'key is {OPENAI_SECRET}') == ['OpenAI API key']
    assert find_secrets(f'key is {ANTHROPIC_SECRET}') == ['Anthropic API key']
    assert find_secrets('AKIAABCDEFGHIJKLMNOP') == ['AWS access key']
    assert find_secrets('a normal preference: prefers tabs') == []
    assert refuse_reason('prefers tabs') is None
    assert 'Refused' in refuse_reason(f'x {OPENAI_SECRET} y')


@pytest.mark.asyncio
async def test_remember_tool_refuses_secret_content(brain_ready):
    from app.services.memory_store import _conn
    from app.services.tool_registrations.memory_tools import _rememberMemory

    out = await _rememberMemory(f'The api key for staging is {OPENAI_SECRET}')
    assert 'Refused' in out
    assert _conn().execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c'] == 0


@pytest.mark.asyncio
async def test_remember_tool_accepts_clean_content(brain_ready):
    from app.services.tool_registrations.memory_tools import _rememberMemory

    out = await _rememberMemory('User prefers tabs over spaces')
    assert 'Remembered' in out


def test_save_auto_memory_backstop_drops_non_user(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    am.saveAutoMemory('leak1', f'staging key {OPENAI_SECRET}', source='auto')
    am.saveAutoMemory('ok1', 'prefers pnpm', source='auto')
    rows = {r['key'] for r in _conn().execute('SELECT key FROM auto_memories').fetchall()}
    assert 'leak1' not in rows
    assert 'ok1' in rows


def test_save_auto_memory_allows_user_source(brain_ready):
    """User-added memories are the user's own choice — not scanned."""
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    am.saveAutoMemory('user_leak', f'my token is {OPENAI_SECRET}', source='user')
    rows = {r['key'] for r in _conn().execute('SELECT key FROM auto_memories').fetchall()}
    assert 'user_leak' in rows


@pytest.mark.asyncio
async def test_background_review_drops_secret_facts(brain_ready):
    import json

    from app.services.memory import background_review as br
    from app.services.memory_store import get_memory

    async def stubLlm(_prompt):
        return json.dumps(
            {
                'facts': [
                    'User prefers pnpm over npm',
                    f'The deploy token is {OPENAI_SECRET}',
                ],
                'corrections': [],
                'skills': [],
                'frustration': False,
            }
        )

    result = await br._doReview([{'role': 'user', 'content': 'x'}], llm_client=stubLlm)
    core = get_memory('coreMemory')
    facts = [f['fact'] for f in core] if isinstance(core, list) else []
    assert 'User prefers pnpm over npm' in facts
    assert not any(OPENAI_SECRET in str(f) for f in facts)
    assert len(result['facts_added']) == 1
