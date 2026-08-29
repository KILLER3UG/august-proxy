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

Phase L (Part 17, 2026-08-29) tightens this: ALL volatile and per-session
content left the system prompt entirely. <session> keeps only fields stable
for the session lifetime (guardMode/agentMode/circuit hint); goal, plan,
plan status, execution state, todos, title move to the per-turn
<session_state> tail block on the last user message (same injection point
as <memory>/<relevant_skills>). The cache_control breakpoint covers the
WHOLE system block, so any byte diff re-reads 100% of it — and the old
embedded `id:` made every NEW session's prompt unique, guaranteeing a
cold read on turn 1 of every chat. Two new contracts follow: state
transitions must not change the prompt bytes, and two different sessions
on the same workspace must produce IDENTICAL prompts (cross-session cache
eligibility).
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


# ── Phase L (Part 17): volatile purge + cross-session identity ────────────


def test_session_block_holds_no_volatile_or_unique_fields(isolatedData):
    """<session> may contain ONLY session-lifetime-stable, model-facing
    fields. id/title/goal/plan/plan status/execution state/scratchpad/
    todos must never appear there (any one of them busts the cached system
    block — and id/title make every new session's block unique)."""
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession()
    session.title = 'A mutable LLM-generated title'
    session.goal = 'Fix the login bug'
    session.plan = {
        'markdown': '# Plan\n1. repro\n2. fix\n3. test',
        'steps': [{'text': 'repro', 'done': True}, {'text': 'fix', 'done': False}],
    }
    session.planApproved = True
    session.todos = [{'content': 'write test', 'done': False}]
    session._execution_state = {'phase': 'implement', 'step': '2'}
    session._working_memory = 'scratch notes'
    session._failure_feedback = 'last tool broke'

    prompt = _build(session, tools=[{'name': 'read_file'}])
    sessionBlock = prompt.split('<session>', 1)[1].split('</session>', 1)[0]
    for banned in (
        f'id: {session.id}',
        'title:',
        'goal:',
        'plan:',
        'plan status:',
        'execution_state:',
        'scratchpad:',
        'last_tool_failure:',
        'todos:',
    ):
        assert banned not in sessionBlock, f'volatile field {banned!r} re-entered <session>'
    # The stable fields DO stay.
    assert 'guardMode:' in sessionBlock


def test_state_transitions_leave_system_prompt_byte_identical(isolatedData):
    """update_state / title change / plan update between builds must not
    change the system prompt — the <session_state> tail block carries it."""
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession()
    tools = [{'name': 'read_file'}, {'name': 'update_state'}]
    prompt1 = _build(session, tools=tools)

    # Everything the old prompt embedded volatile-ly:
    session.title = 'Retitled by the LLM titler'
    session.goal = 'ship the fix'
    session.plan = {'markdown': '# Fresh plan\n1. new step', 'steps': []}
    session.planApproved = False
    session.todos = [{'content': 'repro', 'done': True}]
    session._execution_state = {'phase': 'verify'}
    session._working_memory = 'fresh scratch'

    prompt2 = _build(session, tools=tools)
    assert prompt2 == prompt1, 'a state/title/plan transition changed the system prompt bytes'

    # And the tail block DOES carry the fresh state.
    tail = wb._sessionStateBlock(session)
    assert '<session_state>' in tail
    assert 'goal: ship the fix' in tail
    assert 'plan:' in tail
    assert 'todos:' in tail
    assert 'Retitled by the LLM titler' in tail


def test_two_sessions_same_workspace_identical_prompts(isolatedData, tmp_path):
    """Cross-session cache eligibility: two DIFFERENT sessions bound to the
    same workspace (and same tool surface) must produce IDENTICAL system
    prompts — otherwise turn 1 of every new chat is a guaranteed cold read
    of the full system block."""
    from app.services.workbench import workbench as wb

    ws = tmp_path / 'proj'
    ws.mkdir()
    tools = [{'name': 'read_file'}, {'name': 'run_command'}]

    s1 = wb.createWorkbenchSession()
    s1.workspacePath = str(ws)
    s1.title = 'First chat'
    s1.goal = 'alpha goal'

    s2 = wb.createWorkbenchSession()
    s2.workspacePath = str(ws)
    s2.title = 'Second chat'
    s2.goal = 'beta goal'
    s2.plan = {'markdown': '# Other plan', 'steps': []}

    p1 = _build(s1, tools=tools)
    p2 = _build(s2, tools=tools)
    assert p1 == p2, 'per-session bytes (id/title/goal) still leak into the system prompt'
    assert 'id:' not in p1.split('<session>', 1)[1].split('</session>', 1)[0]


def test_session_state_tail_block_shape(isolatedData):
    """The tail block renders every purged field and stays empty when the
    session has no state (no junk block on a fresh chat)."""
    from app.services.workbench import workbench as wb

    fresh = wb.createWorkbenchSession()
    assert wb._sessionStateBlock(fresh) == ''

    loaded = wb.createWorkbenchSession()
    loaded.title = ' Bug hunt '
    loaded.goal = 'find the null deref'
    loaded.plan = {
        'steps': [{'text': 'read code', 'done': True}, {'text': 'patch', 'done': False}]
    }
    loaded._execution_state = {'phase': 'investigate'}
    block = wb._sessionStateBlock(loaded)
    assert block.startswith('<session_state>')
    assert 'title: Bug hunt' in block  # collapsed whitespace
    assert 'goal: find the null deref' in block
    assert 'plan:' in block
    assert 'execution: phase=investigate' in block
    assert block.rstrip().endswith('</session_state>')
