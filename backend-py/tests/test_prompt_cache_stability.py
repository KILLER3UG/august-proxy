"""System-prompt byte stability across turns (cache-bust regression, 2026-08-29).

Root cause this guards: the boot memory index rode near the TOP of the
system prompt and was re-read fresh on every buildSystemPrompt() call.
Every completed turn writes an episodic_timeline row, so the index's
"Recent events" section changed bytes each turn — invalidating the
provider's ENTIRE prompt-prefix cache (system prompt + tools + full
conversation) and making every turn after the first a cold re-read
("chat feels slow, it used to be fast").

Fix: the index is frozen per session on the first buildSystemPrompt()
call. Fresh memory still flows per turn through the <memory> tail block
(appended to the latest user message, outside the cached prefix) and
brain_query on demand.

Byte-stability contract for the whole system prompt: across consecutive
buildSystemPrompt() calls for the SAME session (same day, no settings
change), the produced text must be identical. Volatile per-turn state
(execution_state/scratchpad/todos) rides in <session> near the END, so it
only busts the last few percent of the prefix; the test compares full
builds and therefore also fails if a new volatile field ever moves to the
top half of the prompt.
"""

from __future__ import annotations


def _build(session, tools=None):
    from app.services.workbench import workbench as wb

    return wb.buildSystemPrompt(session, tools=tools)


def test_mem_index_frozen_across_timeline_writes(isolatedData):
    """A timeline write (what every completed turn does) must NOT change
    the system prompt for an already-booted session."""
    from app.services import memory_store
    from app.services.memory_store.rest import write_timeline_event
    from app.services.workbench import workbench as wb

    memory_store.init()
    memory_store.save_fact(
        'model:pref', 'User prefers concise answers',
        category='general', source='model', title='Concise answers',
    )
    session = wb.createWorkbenchSession()
    tools = [{'name': 'brain_query'}, {'name': 'remember'}]

    prompt1 = _build(session, tools=tools)
    assert 'Memory index (names only' in prompt1

    # Exactly what the turn loop does at turn end (workbench.py turn loop).
    write_timeline_event(
        session.id, 'user asked something new', category='workbench',
    )
    # The store now holds a row the fresh index would pick up.
    fresh = memory_store.brain_index_snippet()
    assert 'user asked something new' in fresh

    prompt2 = _build(session, tools=tools)
    assert prompt2 == prompt1
    assert 'user asked something new' not in prompt2


def test_mem_index_frozen_once_not_forever(isolatedData):
    """Freeze is per SESSION, not global: a new session's first build sees
    the fresh index (timeline rows written by earlier sessions included)."""
    from app.services import memory_store
    from app.services.memory_store.rest import write_timeline_event
    from app.services.workbench import workbench as wb

    memory_store.init()
    session1 = wb.createWorkbenchSession()
    tools = [{'name': 'brain_query'}, {'name': 'remember'}]
    _build(session1, tools=tools)  # freezes session1's index

    write_timeline_event('other-session', 'later event', category='workbench')

    session2 = wb.createWorkbenchSession()
    prompt = _build(session2, tools=tools)
    assert 'Memory index (names only' in prompt
    assert 'later event' in prompt


def test_system_prompt_byte_stable_across_turns(isolatedData):
    """Two consecutive builds for the same session, no state change between
    them, must produce byte-identical prompts."""
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession()
    tools = [{'name': 'read_file'}, {'name': 'run_command'}]

    assert _build(session, tools=tools) == _build(session, tools=tools)


def test_frozen_index_not_persisted(isolatedData):
    """The freeze attr is session-lifetime only — toDict() (SQLite SOT /
    JSON export) must never carry it."""
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession()
    _build(session, tools=[{'name': 'brain_query'}])
    assert session._frozen_mem_index is not None
    assert '_frozen_mem_index' not in session.toDict()
