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


# ── Part 18 P1.2: scenario extensions (per-turn volatility confinement) ────


def test_memory_nudge_does_not_touch_system_prompt(isolatedData):
    """The memory-habit nudge rides the per-turn tail, never the system
    prompt: queueing and consuming it must leave prompt bytes identical."""
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession()
    tools = [{'name': 'remember'}]
    prompt1 = _build(session, tools=tools)

    wb.queue_memory_habit_nudge(
        session, rounds=5, rememberOffered=True, memWritesOn=True
    )
    prompt2 = _build(session, tools=tools)
    assert prompt2 == prompt1, 'queueing a memory nudge changed the system prompt'

    tail = wb.memory_nudge_block(session, True)
    assert '<memory_nudge>' in tail
    prompt3 = _build(session, tools=tools)
    assert prompt3 == prompt1, 'consuming a memory nudge changed the system prompt'


def test_tool_profile_downgrade_confined_to_tool_sections(isolatedData):
    """A tool-profile downgrade must not disturb the prompt's byte-stable
    prefix: everything up to the intake ``- Tools:`` line (and the non-tool
    blocks) stays byte-identical; only the tool-intake line + capabilities
    tool index change."""
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession()
    full = [{'name': 'read_file'}, {'name': 'run_command'}, {'name': 'write_file'}]
    downgraded = [{'name': 'read_file'}]

    pFull = _build(session, tools=full)
    pDown = _build(session, tools=downgraded)

    iFull = pFull.index('- Tools:')
    iDown = pDown.index('- Tools:')
    assert pFull[:iFull] == pDown[:iDown], 'prefix before the tool intake line drifted'
    # The non-tool blocks (workspace/session/policy) stay identical.
    for block in ('harness_guide', 'workspace', 'session', 'agent'):
        tag = f'<{block}>'
        if tag in pFull:
            segFull = pFull[pFull.index(tag):pFull.index(tag) + 200]
            segDown = pDown[pDown.index(tag):pDown.index(tag) + 200]
            assert segFull == segDown, f'{tag} block drifted under a downgrade'
    # The downgraded surface drops the tools it no longer offers — scoped to
    # the tool_read BUCKET slice (the bulk-note boilerplate legitimately
    # lists write_files etc. regardless of the offered surface).
    toolsFull = pFull.split('<tools>', 1)[1].split('</tools>', 1)[0]
    toolsDown = pDown.split('<tools>', 1)[1].split('</tools>', 1)[0]

    def _bucket(toolsBody: str, bucketName: str) -> str:
        import re as _re

        start = toolsBody.index(f'{bucketName} (')
        m = _re.search(r'\n(tool_(?:write|shell|destructive|agent|skill|bridge|other))\s*\(', toolsBody[start:])
        end = start + m.start() if m else len(toolsBody)
        return toolsBody[start:end]

    # Full surface: each tool renders in its bucket.
    assert 'read_file' in _bucket(toolsFull, 'tool_read')
    assert 'run_command' in _bucket(toolsFull, 'tool_shell')
    assert 'write_file' in _bucket(toolsFull, 'tool_write')
    # Downgraded surface: the read bucket keeps read_file; the buckets it no
    # longer holds are omitted entirely.
    assert 'read_file' in _bucket(toolsDown, 'tool_read')
    assert 'tool_shell (' not in toolsDown and 'tool_write (' not in toolsDown


def test_skill_catalogue_change_confined_to_skills_sections(isolatedData, monkeypatch, tmp_path):
    """A skill-creation catalogue change busts the prompt caches (rare,
    deliberate) and must be CONFINED to the skills surface: the byte-stable
    prefix up to the intake ``- Skills:`` line, the blocks between that line
    and <capabilities>, and the tools section all stay identical."""
    import time as _t

    from app.services import skill_service
    from app.services.workbench import workbench as wb

    skill_service._flat_migrate_done = True
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: tmp_path / 'agent-skills')
    (tmp_path / 'agent-skills').mkdir(parents=True, exist_ok=True)

    session = wb.createWorkbenchSession()
    tools = [{'name': 'load_skill'}, {'name': 'read_file'}]
    p1 = _build(session, tools=tools)

    _t.sleep(0.02)  # distinct SKILL.md mtime for the memo key
    skill_service.createSkill(
        'stability-new-skill', 'A brand new described skill', 'Body.', created_by='human'
    )
    p2 = _build(session, tools=tools)

    i1 = p1.index('- Skills:')
    i2 = p2.index('- Skills:')
    assert p1[:i1] == p2[:i2], 'prefix before the skills intake line drifted'
    assert 'stability-new-skill' in p2
    cap1 = p1[p1.index('<capabilities>'):]
    cap2 = p2[p2.index('<capabilities>'):]
    tools1 = cap1[cap1.index('<tools>'):cap1.index('</tools>')]
    tools2 = cap2[cap2.index('<tools>'):cap2.index('</tools>')]
    assert tools1 == tools2, 'tools section changed when only the skills catalogue grew'


def test_skill_in_place_description_edit_system_prompt_stable(isolatedData, monkeypatch, tmp_path):
    """P1.4 wire-through from the prompt: the main-agent skills index is
    NAME-ONLY, so an in-place description edit (a catalogue mutation that
    busts the prompt caches) must leave the system prompt byte-identical —
    descriptions ride in <relevant_skills> per turn, not the cached index."""
    import time as _t

    from app.services import skill_service
    from app.services.workbench import workbench as wb

    skill_service._flat_migrate_done = True
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: tmp_path / 'agent-skills')
    (tmp_path / 'agent-skills').mkdir(parents=True, exist_ok=True)

    session = wb.createWorkbenchSession()
    tools = [{'name': 'load_skill'}, {'name': 'read_file'}]
    p1 = _build(session, tools=tools)
    assert p1 == _build(session, tools=tools), 'consecutive builds of the same session diverged'

    _t.sleep(0.02)
    skill_service.createSkill('stable-desc-skill', 'first description', 'Body.', created_by='human')
    p2 = _build(session, tools=tools)
    assert 'stable-desc-skill' in p2

    _t.sleep(0.02)
    skill_service.patchSkill('stable-desc-skill', description='second description')
    p3 = _build(session, tools=tools)
    assert p3 == p2, 'an in-place description edit changed the cached system prefix'
    assert 'second description' not in p3.split('<capabilities>', 1)[1].split('</skills>', 1)[0]
