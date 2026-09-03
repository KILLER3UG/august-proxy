"""Bot Mode Phase A — roster + canonical Bot Chat (2026-09-01 plan §3 Phase A).

A Bot is an agent-registry record + ``uiMeta`` (title/avatar/hidden/groups)
stored on the same KV blob. Creating a Bot creates exactly one canonical
workbench chat (title ``Bot Chat``, ``metadata.canonicalBotChat=<agentId>``);
``/new`` in that session reroutes to compaction, never a fresh fork.
"""

from __future__ import annotations

import asyncio

# ── uiMeta on the registry ─────────────────────────────────────────────────


def test_create_bot_stores_uimeta(isolatedData):
    from app.services.bot_mode import roster

    bot = roster.create_bot(
        name='Researcher',
        title='Research Buddy',
        description='Finds and summarizes sources',
        role='You are a careful research assistant.',
        actor='test',
    )
    assert bot['id'].startswith('agent_')
    meta = bot['uiMeta']
    assert meta['title'] == 'Research Buddy'
    assert meta['hidden'] is False
    assert meta['groups'] == []
    assert meta['avatar'] == ''  # set later; default is the identicon

    from app.services.tools.agent_registry import getAgent

    stored = getAgent(bot['id'])
    assert stored is not None
    assert stored['uiMeta']['title'] == 'Research Buddy'


def test_create_bot_is_idempotent_on_name(isolatedData):
    """Same name twice → same Bot record (no duplicate roster rows)."""
    from app.services.bot_mode import roster

    a = roster.create_bot(name='Researcher', title='R', actor='test')
    b = roster.create_bot(name='Researcher', title='R2', actor='test')
    assert a['id'] == b['id']
    from app.services.tools import agent_registry

    same = [x for x in agent_registry.listAgents() if x.get('name') == 'Researcher']
    assert len(same) == 1


def test_update_bot_uimeta(isolatedData):
    from app.services.bot_mode import roster

    bot = roster.create_bot(name='Critic', title='C', actor='test')
    updated = roster.update_bot(bot['id'], {'title': 'Red Team', 'hidden': True})
    assert updated is not None
    assert updated['uiMeta']['title'] == 'Red Team'
    assert updated['uiMeta']['hidden'] is True


def test_list_bots_hidden_flag(isolatedData):
    from app.services.bot_mode import roster

    roster.create_bot(name='A', title='A', actor='test')
    roster.create_bot(name='B', title='B', actor='test')
    roster.update_bot_by_name('B', {'hidden': True})

    bots = roster.list_bots()
    assert [b['name'] for b in bots] == ['A', 'B']  # hidden stays listed (display filter is UI)


def test_delete_bot_removes_record(isolatedData):
    from app.services.bot_mode import roster

    bot = roster.create_bot(name='Temp', title='T', actor='test')
    assert roster.delete_bot(bot['id'], actor='test') is True
    from app.services.tools.agent_registry import getAgent

    assert getAgent(bot['id']) is None


def test_default_agent_undeletable(isolatedData):
    from app.services.bot_mode import roster

    roster.ensure_default_bot(actor='test')
    default = roster.get_default_bot()
    assert default is not None
    assert roster.delete_bot(default['id'], actor='test') is False


# ── canonical Bot Chat ─────────────────────────────────────────────────────


def test_create_bot_creates_canonical_chat(isolatedData):
    from app.services.bot_mode import roster
    from app.services.workbench import sessions as sessions_mod

    bot = roster.create_bot(name='Researcher', title='R', actor='test')
    chat = roster.ensure_canonical_bot_chat(bot['id'])
    assert chat is not None
    assert chat.title == 'Bot Chat'
    assert chat.agentId == bot['id']
    assert chat.metadata.get('canonicalBotChat') == bot['id']


def test_canonical_chat_is_idempotent(isolatedData):
    from app.services.bot_mode import roster

    bot = roster.create_bot(name='Researcher', title='R', actor='test')
    first = roster.ensure_canonical_bot_chat(bot['id'])
    again = roster.ensure_canonical_bot_chat(bot['id'])
    assert first.id == again.id


def test_canonical_chat_survives_session_reload(isolatedData):
    from app.services.bot_mode import roster
    from app.services.workbench import sessions as sessions_mod

    bot = roster.create_bot(name='Researcher', title='R', actor='test')
    chat = roster.ensure_canonical_bot_chat(bot['id'])
    sessions_mod._sessions.clear()  # simulate restart; SQLite blob stays
    found = roster.ensure_canonical_bot_chat(bot['id'])
    assert found.id == chat.id
    assert found.metadata.get('canonicalBotChat') == bot['id']


def test_new_command_reroutes_to_compact(isolatedData):
    """/new in a canonical Bot Chat must compact instead of forking."""
    from app.services.bot_mode import roster
    from app.services.workbench import sessions as sessions_mod

    bot = roster.create_bot(name='Researcher', title='R', actor='test')
    chat = roster.ensure_canonical_bot_chat(bot['id'])
    # Pretend a real conversation happened (compaction needs ≥6 messages).
    for i in range(8):
        chat.messages.append(
            {'role': 'user' if i % 2 == 0 else 'assistant', 'content': f'msg {i}'}
        )
    ids_before = {s.id for s in sessions_mod._sessions.values()}

    redirected = roster.reroute_new_for_canonical_chat(chat.id)
    assert redirected is True
    # No fork: the canonical chat is still there, nothing new was created.
    assert {s.id for s in sessions_mod._sessions.values()} == ids_before
    assert roster.ensure_canonical_bot_chat(bot['id']).id == chat.id


def test_new_command_not_redirected_for_regular_session(isolatedData):
    from app.services.bot_mode import roster
    from app.services.workbench import sessions as sessions_mod

    session = sessions_mod.create_workbench_session()
    assert roster.reroute_new_for_canonical_chat(session.id) is False


def test_reset_workbench_session_guard(isolatedData):
    """The backend reset path (the /new equivalent) must refuse to delete a
    canonical Bot Chat — compaction is the only fresh start."""
    from app.services.bot_mode import roster
    from app.services.workbench import sessions as sessions_mod

    bot = roster.create_bot(name='Researcher', title='R', actor='test')
    chat = roster.ensure_canonical_bot_chat(bot['id'])
    result = sessions_mod.reset_workbench_session(chat.id)
    # Guard: the same session survives (reset was refused or rerouted to compact).
    assert sessions_mod.get_workbench_session(chat.id) is not None
    assert result is None or result.id == chat.id


# ── avatars (deterministic identicon) ──────────────────────────────────────


def test_avatar_svg_deterministic(isolatedData):
    from app.services.bot_mode import roster

    a = roster.avatar_svg('Researcher')
    b = roster.avatar_svg('Researcher')
    c = roster.avatar_svg('Critic')
    assert a == b, 'same name → identical SVG bytes'
    assert a != c, 'different name → different SVG bytes'
    assert a.startswith('<svg') and a.rstrip().endswith('</svg>')


def test_avatar_salt_changes_bytes(isolatedData):
    from app.services.bot_mode import roster

    base = roster.avatar_svg('Researcher')
    salted = roster.avatar_svg('Researcher', salt='x1')
    assert base != salted
    assert roster.avatar_svg('Researcher', salt='x1') == salted


# ── first-message intro turn ───────────────────────────────────────────────


def test_intro_turn_runs_headless(isolatedData, monkeypatch):
    """Bot birth runs ONE headless intro turn in the canonical chat; the
    turn is agent-attributed and free of user text."""
    from app.services.bot_mode import roster

    captured: dict[str, object] = {}

    def fake_intro(agent_id: str, session_id: str) -> None:
        captured['agentId'] = agent_id
        captured['sessionId'] = session_id

    monkeypatch.setattr('app.services.bot_mode.roster._run_intro_turn', fake_intro)

    bot = roster.create_bot(
        name='Researcher', title='R', role='Research assistant.', actor='test'
    )
    assert captured.get('agentId') == bot['id']
    chat = roster.ensure_canonical_bot_chat(bot['id'])
    assert captured.get('sessionId') == chat.id
