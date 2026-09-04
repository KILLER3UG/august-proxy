"""Part 19 Phase B — routines: Bot-owned automation jobs + M-11 notepad door.

A **routine** is an automations_store job with three extra fields:

* ``agentId`` — the owning Bot; the job name is namespaced ``[bot:<name>]
  <title>`` so Automations UI rows are attributable.
* ``deliver: 'bot-chat'`` — on completion the result lands in the Bot's
  canonical Bot Chat (``deliver_to_bot_chat``, respond-mode default on).
* ``respond: bool`` — with delivery on, run a workbench turn so the Bot
  reacts to its own routine output (default true).

Tools (registered for every session — the job surface itself is not
privileged; the Bot's roster hint tells it these exist):

* ``create_routine`` — create (or upsert by name) a Bot routine.
* ``list_routines`` — the calling Bot's routines (all routines with
  ``all=true``).
* ``delete_routine`` — remove by routine name or job id.
* ``job_notes`` — M-11 notepad get/set/delete, callable only from sessions
  marked as automation runs (metadata double-check, same pattern as the
  Phase C injection gate).
"""

from __future__ import annotations

import json

from app.json_narrowing import as_bool, as_str


def _ok(**fields: object) -> str:
    return json.dumps({'status': 'success', **fields}, default=str)


def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)


def routine_display_name(bot_name: str, title: str) -> str:
    """The namespaced job title: ``[bot:<name>] <title>``."""
    return f'[bot:{bot_name}] {title}'


def _parse_display_name(display: str) -> tuple[str, str]:
    """Split a namespaced title back into (bot_name, title)."""
    if display.startswith('[bot:') and ']' in display:
        head, _, rest = display.partition(']')
        return head[len('[bot:') :], rest.strip()
    return '', display


def _current_bot() -> dict[str, object]:
    """The Bot record for the session executing this tool call."""
    from app.services.workbench.workbench import get_session

    session = get_session()
    agent_id = getattr(session, 'agentId', '') if session else ''
    if not agent_id:
        return {}
    from app.services.tools import agent_registry

    agent = agent_registry.getAgent(agent_id)
    return agent if isinstance(agent, dict) else {}


async def createRoutine(
    title: str,
    prompt: str = '',
    schedule: str = '',
    command: str = '',
    jobType: str = 'workbench',
    timezone: str = '',
    respond: bool = True,
    continuity: bool = False,
) -> str:
    """Create (or update, matched by title) a routine for the calling Bot."""
    from app.services import automations_store

    try:
        bot = _current_bot()
        bot_name = as_str(bot.get('name'))
        if not bot_name:
            return _err(
                'create_routine is only callable from a Bot session '
                '(the chat of a Bot/agent).'
            )
        if not prompt and not command:
            return _err('A routine needs a prompt (agent run) or a command (shell run).')
        if not schedule:
            return _err('A routine needs a schedule (e.g. "every 1h", a cron expr, or "daily 09:00").')
        job_name = routine_display_name(bot_name, title)
        job: dict[str, object] = {
            'name': job_name,
            'agentId': as_str(bot.get('id')),
            'deliver': 'bot-chat',
            'respond': bool(respond),
            'continuity': bool(continuity),
            'schedule': schedule,
            'jobType': jobType or 'workbench',
        }
        if timezone:
            job['timezone'] = timezone
        if prompt:
            job['prompt'] = prompt
        if command:
            job['command'] = command
        # Upsert semantics keyed by the namespaced name: creating "Morning
        # brief" twice for the same Bot updates that routine, never forks.
        existing = next(
            (j for j in automations_store.list_jobs() if as_str(j.get('name')) == job_name),
            None,
        )
        if existing:
            job['id'] = as_str(existing.get('id'))
        created = await automations_store.upsert_job_async(job)
        return _ok(routine=created, name=job_name)
    except ValueError as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f'Failed to create routine: {exc}')


async def listRoutines(all: bool = False) -> str:
    """List routines. Defaults to the calling Bot's; ``all=true`` lists every Bot's."""
    from app.services import automations_store

    jobs = automations_store.list_jobs()
    if not all:
        bot = _current_bot()
        bot_name = as_str(bot.get('name'))
        if not bot_name:
            return _err('No Bot is bound to this session.')
        jobs = [j for j in jobs if as_str(j.get('name')).startswith(f'[bot:{bot_name}]')]
    else:
        jobs = [j for j in jobs if as_str(j.get('name')).startswith('[bot:')]
    out = []
    for j in jobs:
        bot_name, title = _parse_display_name(as_str(j.get('name')))
        out.append(
            {
                'id': as_str(j.get('id')),
                'title': title or as_str(j.get('name')),
                'bot': bot_name,
                'schedule': as_str(j.get('schedule')),
                'jobType': as_str(j.get('jobType')),
                'paused': as_bool(j.get('paused'), False),
                'enabled': as_bool(j.get('enabled'), True),
                'deliver': as_str(j.get('deliver')),
                'status': as_str(j.get('status')),
                'lastRunAt': as_str(j.get('lastRunAt')),
            }
        )
    return _ok(routines=out)


async def deleteRoutine(routine: str) -> str:
    """Delete a routine by job id or by ``[bot:<name>] <title>`` / bare title.

    2.11 (Part 25): a BARE title only resolves within the CALLING Bot's own
    ``[bot:<name>]`` namespace — Bot A cannot delete Bot B's same-titled
    routine. An explicit job id or a full ``[bot:x] title`` string still works.
    """
    from app.services import automations_store

    caller_name = as_str(_current_bot().get('name'))
    jobs = automations_store.list_jobs()
    target = None
    for j in jobs:
        name = as_str(j.get('name'))
        if not name.startswith('[bot:'):
            continue
        if as_str(j.get('id')) == routine or name == routine:
            target = j
            break
        bot, title = _parse_display_name(name)
        if title == routine and caller_name and bot == caller_name:
            target = j
            break
    if target is None:
        return _err(f"Routine '{routine}' not found.")
    ok = await automations_store.delete_job_async(as_str(target.get('id')))
    if not ok:
        return _err(f"Routine '{routine}' could not be deleted.")
    return _ok(deleted=as_str(target.get('name')))


async def jobNotes(
    action: str = 'get',
    key: str = '',
    value: str = '',
    jobId: str = '',
) -> str:
    """M-11 notepad door — get/set/delete per-job notes.

    Callable only from a session whose metadata marks it as an automation
    run (the same double-check pattern as the Phase C injection gate): a
    forged call from a regular chat gets a structured error, not a write.
    An explicit ``jobId`` may only narrow the target WITHIN an automation
    session — otherwise any chat could write notes that land in an
    unattended routine's next wake context.
    """
    from app.services import automation_memory
    from app.services.workbench.workbench import get_session

    try:
        session = get_session()
        meta = getattr(session, 'metadata', None) if session else None
        meta = meta if isinstance(meta, dict) else {}
        session_job = as_str(meta.get('automationJobId'))
        if not session_job and not jobId:
            return _err('job_notes is only callable from an automation run session.')
        if jobId and not session_job:
            return _err(
                'job_notes cannot target an arbitrary jobId — explicit ids are '
                'only valid inside that job\'s own automation session.'
            )
        job_id = jobId or session_job
        act = (action or 'get').strip().lower()
        if act == 'get':
            return _ok(notes=automation_memory.get_notes(job_id))
        if act == 'set':
            if not key:
                return _err('set requires a key.')
            err = automation_memory.set_note(job_id, key, value)
            if err:
                return _err(f'Note not saved: {err}.')
            return _ok(saved=key)
        if act == 'delete':
            if not key:
                return _err('delete requires a key.')
            err = automation_memory.delete_note(job_id, key)
            if err:
                return _err(f'Note not deleted: {err}.')
            return _ok(deleted=key)
        return _err(f"Unknown action '{action}' — use get | set | delete.")
    except Exception as exc:
        return _err(f'job_notes failed: {exc}')


def register() -> None:
    """Register the routine + automation-memory tools."""
    from app.services import tool_registry

    tool_registry.register(
        'create_routine',
        'Create or update a scheduled routine for the calling Bot (agent). The result is delivered '
        'into the Bot chat when the run finishes (respond=true also lets the Bot act on it). '
        'schedule accepts "every <interval>", "daily HH:MM", or a cron expression.',
        createRoutine,
        {
            'type': 'object',
            'properties': {
                'title': {'type': 'string', 'description': 'Short routine title (e.g. "Morning brief").'},
                'prompt': {
                    'type': 'string',
                    'description': 'What the Bot should do each run (agent job). Either prompt or command is required.',
                },
                'command': {
                    'type': 'string',
                    'description': 'Shell command to run each time (shell job).',
                },
                'schedule': {
                    'type': 'string',
                    'description': 'How often to run: "every 30m", "daily 09:00", "hourly", or cron like "0 9 * * *".',
                },
                'jobType': {
                    'type': 'string',
                    'description': 'workbench (default, runs the prompt as the Bot) | shell | http.',
                },
                'timezone': {'type': 'string', 'description': 'IANA timezone for the schedule (default: local).'},
                'respond': {
                    'type': 'boolean',
                    'description': 'With bot-chat delivery, run a Bot turn reacting to the result (default true).',
                },
                'continuity': {
                    'type': 'boolean',
                    'description': 'Include the previous run result tail as "what you did last time" (default false).',
                },
            },
            'required': ['title', 'schedule'],
        },
    )
    tool_registry.register(
        'list_routines',
        'List the calling Bot\'s scheduled routines (all=true lists every Bot\'s).',
        listRoutines,
        {
            'type': 'object',
            'properties': {
                'all': {'type': 'boolean', 'description': 'List routines of all Bots (default false).'},
            },
            'required': [],
        },
    )
    tool_registry.register(
        'delete_routine',
        'Delete a routine by its id, full "[bot:<name>] <title>", or bare title.',
        deleteRoutine,
        {
            'type': 'object',
            'properties': {
                'routine': {'type': 'string', 'description': 'Routine id or title to delete.'},
            },
            'required': ['routine'],
        },
    )
    tool_registry.register(
        'job_notes',
        'Per-run-job notepad for automation sessions: persist decisions/state between runs '
        '(action=get|set|delete, key, value). Only callable from automation run sessions.',
        jobNotes,
        {
            'type': 'object',
            'properties': {
                'action': {'type': 'string', 'description': 'get | set | delete (default get).'},
                'key': {'type': 'string', 'description': 'Note key (e.g. last_cursor, pending_items).'},
                'value': {'type': 'string', 'description': 'Note value for set (4 KiB cap per key).'},
                'jobId': {'type': 'string', 'description': 'Explicit job id (default: this session\'s job).'},
            },
            'required': [],
        },
    )


def _bot_routines(bot_name: str) -> list[dict[str, object]]:
    """All jobs namespaced for one Bot (helper for roster hint + pane)."""
    from app.services import automations_store

    prefix = f'[bot:{bot_name}]'
    return [j for j in automations_store.list_jobs() if as_str(j.get('name')).startswith(prefix)]


def routines_hint(agent_id: str) -> str:
    """The one-line roster hint injected into a Bot's system context."""
    from app.services.tools import agent_registry

    agent = agent_registry.getAgent(agent_id)
    name = as_str(agent.get('name')) if isinstance(agent, dict) else ''
    if not name:
        return ''
    if _bot_routines(name):
        return (
            'You have scheduled routines; manage them with the create_routine / '
            'list_routines / delete_routine tools.'
        )
    return ''
