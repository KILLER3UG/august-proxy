"""Homogeneous bulk tools — one call for many items of the same operation.

Prefer these over repeating a single-item tool N times in one turn.
Also exposes a meta ``bulk`` tool so the model can discover the feature by name.
"""

from __future__ import annotations

import asyncio

from app.json_narrowing import as_str
from app.services import tool_registry
from app.services.tool_registrations.bulk_helpers import (
    BULK_MAX_ITEMS,
    coerce_object_list,
    coerce_str_list,
    format_bulk_report,
)

BULK_OPS = (
    'read_files',
    'write_files',
    'delete_sessions',
    'rename_sessions',
    'kill_daemons',
    'fetch_urls',
    'load_skills',
)


async def _bulk_read_files(paths: object = None, path: str = '') -> str:
    from app.services.tool_registrations.file_tools import _readFile

    ids = coerce_str_list(paths, single=path)
    if not ids:
        return 'Error: paths is required (array of file paths to read).'
    results = await asyncio.gather(*[_readFile(p) for p in ids], return_exceptions=True)
    blocks: list[str] = []
    ok: list[str] = []
    errors: list[str] = []
    for p, res in zip(ids, results, strict=False):
        if isinstance(res, BaseException):
            errors.append(f'{p}: {res}')
            continue
        text = str(res)
        if text.startswith('Error'):
            errors.append(f'{p}: {text}')
            continue
        ok.append(p)
        blocks.append(f'===== {p} =====\n{text}')
    header = format_bulk_report(label='read_files', total=len(ids), ok_ids=ok, errors=errors)
    body = '\n\n'.join(blocks) if blocks else '(no files read)'
    return f'{header}\n\n{body}'


async def _bulk_write_files(files: object = None) -> str:
    from app.services.tool_registrations.file_tools import _writeFile

    items = coerce_object_list(files)
    if not items:
        return (
            'Error: files is required — array of {path, content} objects '
            '(max %d).' % BULK_MAX_ITEMS
        )
    ok: list[str] = []
    errors: list[str] = []
    for entry in items:
        path = as_str(entry.get('path') or entry.get('filePath') or entry.get('file'))
        content = entry.get('content')
        if content is None:
            content = entry.get('text') or entry.get('body') or ''
        if not path:
            errors.append('(missing path)')
            continue
        try:
            res = await _writeFile(path, str(content))
            if str(res).startswith('Error'):
                errors.append(f'{path}: {res}')
            else:
                ok.append(path)
        except Exception as exc:
            errors.append(f'{path}: {exc}')
    return format_bulk_report(label='write_files', total=len(items), ok_ids=ok, errors=errors)


async def _bulk_delete_sessions(sessionIds: object = None, sessionId: str = '') -> str:
    from app.services.tool_registrations.memory_tools import _deleteSessions

    return await _deleteSessions(sessionIds=sessionIds, sessionId=sessionId)


async def _bulk_rename_sessions(renames: object = None, items: object = None) -> str:
    from app.services.tool_registrations.memory_tools import _renameSession

    entries = coerce_object_list(renames if renames is not None else items)
    if not entries:
        return (
            'Error: renames is required — array of {sessionId, title} objects '
            f'(max {BULK_MAX_ITEMS}).'
        )
    ok: list[str] = []
    errors: list[str] = []
    for entry in entries:
        sid = as_str(entry.get('sessionId') or entry.get('id'))
        title = as_str(entry.get('title') or entry.get('name'))
        if not sid or not title:
            errors.append(f'{sid or "?"}: need sessionId and title')
            continue
        try:
            res = await _renameSession(sessionId=sid, title=title)
            if str(res).startswith('Error') or 'not found' in str(res).lower():
                errors.append(f'{sid}: {res}')
            else:
                ok.append(f'{sid}→{title}')
        except Exception as exc:
            errors.append(f'{sid}: {exc}')
    return format_bulk_report(label='rename_sessions', total=len(entries), ok_ids=ok, errors=errors)


async def _bulk_kill_daemons(daemonIds: object = None, daemonId: str = '') -> str:
    from app.services.tool_registrations.agent_tools import _killDaemon

    ids = coerce_str_list(daemonIds, single=daemonId)
    if not ids:
        return 'Error: daemonIds is required (array of daemon ids to kill).'
    ok: list[str] = []
    missing: list[str] = []
    errors: list[str] = []
    for did in ids:
        try:
            res = await _killDaemon(did)
            low = str(res).lower()
            if 'not found' in low:
                missing.append(did)
            elif str(res).startswith('Error'):
                errors.append(f'{did}: {res}')
            else:
                ok.append(did)
        except Exception as exc:
            errors.append(f'{did}: {exc}')
    return format_bulk_report(
        label='kill_daemons',
        total=len(ids),
        ok_ids=ok,
        missing=missing,
        errors=errors,
    )


async def _bulk_fetch_urls(urls: object = None, url: str = '') -> str:
    from app.services.tool_registrations.web_tools import _webFetch

    ids = coerce_str_list(urls, single=url)
    if not ids:
        return 'Error: urls is required (array of URLs to fetch).'
    # Parallel fetch — selective page bodies after web_search snippets.
    results = await asyncio.gather(*[_webFetch(u) for u in ids], return_exceptions=True)
    blocks: list[str] = []
    ok: list[str] = []
    errors: list[str] = []
    for u, res in zip(ids, results, strict=False):
        if isinstance(res, BaseException):
            errors.append(f'{u}: {res}')
            continue
        text = str(res)
        if text.startswith('Error'):
            errors.append(f'{u}: {text}')
            continue
        ok.append(u)
        # Cap each body so a bulk fetch stays readable.
        body = text if len(text) <= 12000 else text[:12000] + '\n…(truncated)'
        blocks.append(f'===== {u} =====\n{body}')
    header = format_bulk_report(label='fetch_urls', total=len(ids), ok_ids=ok, errors=errors)
    body = '\n\n'.join(blocks) if blocks else '(no pages fetched)'
    return f'{header}\n\n{body}'


async def _bulk_load_skills(names: object = None, name: str = '') -> str:
    from app.services.tool_registrations.skill_tools import _loadSkill

    ids = coerce_str_list(names, single=name)
    if not ids:
        return 'Error: names is required (array of skill names to load).'
    results = await asyncio.gather(*[_loadSkill(n) for n in ids], return_exceptions=True)
    blocks: list[str] = []
    ok: list[str] = []
    errors: list[str] = []
    for n, res in zip(ids, results, strict=False):
        if isinstance(res, BaseException):
            errors.append(f'{n}: {res}')
            continue
        text = str(res)
        if text.startswith('Error'):
            errors.append(f'{n}: {text}')
            continue
        ok.append(n)
        blocks.append(text)
    header = format_bulk_report(label='load_skills', total=len(ids), ok_ids=ok, errors=errors)
    body = '\n\n---\n\n'.join(blocks) if blocks else '(no skills loaded)'
    return f'{header}\n\n{body}'


async def _bulk(
    operation: str = '',
    paths: object = None,
    files: object = None,
    sessionIds: object = None,
    sessionId: str = '',
    renames: object = None,
    items: object = None,
    daemonIds: object = None,
    daemonId: str = '',
    urls: object = None,
    url: str = '',
    names: object = None,
    name: str = '',
) -> str:
    """Meta bulk dispatcher — one entry point for homogeneous multi-item work."""
    op = (operation or '').strip().lower().replace('-', '_')
    # Allow operation aliases
    aliases = {
        'read': 'read_files',
        'read_file': 'read_files',
        'write': 'write_files',
        'write_file': 'write_files',
        'delete_session': 'delete_sessions',
        'rename_session': 'rename_sessions',
        'kill_daemon': 'kill_daemons',
        'web_fetch': 'fetch_urls',
        'fetch': 'fetch_urls',
        'load_skill': 'load_skills',
    }
    op = aliases.get(op, op)
    if op not in BULK_OPS:
        return (
            'Error: unknown bulk operation. Use one of: '
            + ', '.join(BULK_OPS)
            + f'. Got: {operation!r}'
        )
    if op == 'read_files':
        return await _bulk_read_files(paths=paths)
    if op == 'write_files':
        return await _bulk_write_files(files=files if files is not None else items)
    if op == 'delete_sessions':
        return await _bulk_delete_sessions(sessionIds=sessionIds, sessionId=sessionId)
    if op == 'rename_sessions':
        return await _bulk_rename_sessions(renames=renames, items=items)
    if op == 'kill_daemons':
        return await _bulk_kill_daemons(daemonIds=daemonIds, daemonId=daemonId)
    if op == 'fetch_urls':
        return await _bulk_fetch_urls(urls=urls, url=url)
    if op == 'load_skills':
        return await _bulk_load_skills(names=names, name=name)
    return f'Error: bulk operation {op!r} is not implemented.'


def register() -> None:
    """Register the meta ``bulk`` tool and named bulk variants."""
    tool_registry.register(
        'bulk',
        'Execute the SAME operation on many items in one call (prefer over repeating a tool). '
        'Set operation to one of: read_files, write_files, delete_sessions, rename_sessions, '
        'kill_daemons, fetch_urls, load_skills. Pass the matching array field '
        '(paths / files / sessionIds / renames / daemonIds / urls / names). '
        f'Max {BULK_MAX_ITEMS} items per call. Mutating ops still need user confirmation in ask mode.',
        _bulk,
        {
            'type': 'object',
            'properties': {
                'operation': {
                    'type': 'string',
                    'enum': list(BULK_OPS),
                    'description': 'Which bulk operation to run.',
                },
                'paths': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'For read_files: file paths.',
                },
                'files': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'path': {'type': 'string'},
                            'content': {'type': 'string'},
                        },
                        'required': ['path', 'content'],
                    },
                    'description': 'For write_files: [{path, content}, …].',
                },
                'sessionIds': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'For delete_sessions: session IDs.',
                },
                'renames': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'sessionId': {'type': 'string'},
                            'title': {'type': 'string'},
                        },
                        'required': ['sessionId', 'title'],
                    },
                    'description': 'For rename_sessions: [{sessionId, title}, …].',
                },
                'daemonIds': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'For kill_daemons: daemon IDs.',
                },
                'urls': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'For fetch_urls: URLs to fetch in parallel.',
                },
                'names': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'For load_skills: skill names.',
                },
                'items': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'Alias for files/renames when convenient.',
                },
            },
            'required': ['operation'],
        },
    )

    tool_registry.register(
        'read_files',
        f'Read multiple files in one call (max {BULK_MAX_ITEMS}). Prefer over many read_file calls.',
        _bulk_read_files,
        {
            'type': 'object',
            'properties': {
                'paths': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'File paths to read.',
                },
            },
            'required': ['paths'],
        },
    )
    tool_registry.register(
        'write_files',
        f'Write multiple files in one call (max {BULK_MAX_ITEMS}). Prefer over many write_file calls. '
        'Confirm with the user before bulk-writing.',
        _bulk_write_files,
        {
            'type': 'object',
            'properties': {
                'files': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'path': {'type': 'string'},
                            'content': {'type': 'string'},
                        },
                        'required': ['path', 'content'],
                    },
                    'description': 'Files to write: [{path, content}, …].',
                },
            },
            'required': ['files'],
        },
    )
    tool_registry.register(
        'rename_sessions',
        f'Rename multiple chat sessions in one call (max {BULK_MAX_ITEMS}).',
        _bulk_rename_sessions,
        {
            'type': 'object',
            'properties': {
                'renames': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'sessionId': {'type': 'string'},
                            'title': {'type': 'string'},
                        },
                        'required': ['sessionId', 'title'],
                    },
                },
            },
            'required': ['renames'],
        },
    )
    tool_registry.register(
        'kill_daemons',
        f'Kill multiple daemons in one call (max {BULK_MAX_ITEMS}).',
        _bulk_kill_daemons,
        {
            'type': 'object',
            'properties': {
                'daemonIds': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Daemon IDs from list_daemons.',
                },
            },
            'required': ['daemonIds'],
        },
    )
    tool_registry.register(
        'web_fetch_many',
        f'Fetch multiple URLs in parallel (max {BULK_MAX_ITEMS}). Prefer over many web_fetch calls.',
        _bulk_fetch_urls,
        {
            'type': 'object',
            'properties': {
                'urls': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'URLs to fetch.',
                },
            },
            'required': ['urls'],
        },
    )
    tool_registry.register(
        'load_skills',
        f'Load multiple skills in one call (max {BULK_MAX_ITEMS}). Prefer over many load_skill calls.',
        _bulk_load_skills,
        {
            'type': 'object',
            'properties': {
                'names': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Skill names from list_skills.',
                },
            },
            'required': ['names'],
        },
    )
