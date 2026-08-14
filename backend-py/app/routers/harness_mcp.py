"""MCP JSON-RPC surface so outer agents can run August as a slow loop."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.json_narrowing import as_dict, as_list, as_str

router = APIRouter()

_TOOLS = [
    {
        'name': 'harness_list_workstreams',
        'description': 'List named workstreams and latest episodes for a session.',
        'inputSchema': {
            'type': 'object',
            'properties': {'sessionId': {'type': 'string'}},
            'required': ['sessionId'],
        },
    },
    {
        'name': 'harness_spawn',
        'description': 'Dispatch a DAG of workstream workers (background job).',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'sessionId': {'type': 'string'},
                'workItems': {'type': 'array', 'items': {'type': 'object'}},
                'background': {'type': 'boolean', 'default': True},
            },
            'required': ['sessionId', 'workItems'],
        },
    },
    {
        'name': 'harness_steer',
        'description': 'Queue a steering message for a running worker taskId.',
        'inputSchema': {
            'type': 'object',
            'properties': {'taskId': {'type': 'string'}, 'message': {'type': 'string'}},
            'required': ['taskId', 'message'],
        },
    },
    {
        'name': 'harness_continue',
        'description': 'Continue a named workstream with a fresh worker.',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'sessionId': {'type': 'string'},
                'name': {'type': 'string'},
                'message': {'type': 'string'},
            },
            'required': ['sessionId', 'name', 'message'],
        },
    },
    {
        'name': 'harness_list_jobs',
        'description': 'List long-running harness jobs for a session.',
        'inputSchema': {
            'type': 'object',
            'properties': {'sessionId': {'type': 'string'}},
            'required': ['sessionId'],
        },
    },
    {
        'name': 'harness_cancel_job',
        'description': 'Cancel a harness job and its in-flight workers.',
        'inputSchema': {
            'type': 'object',
            'properties': {'jobId': {'type': 'string'}},
            'required': ['jobId'],
        },
    },
]


def _ok(req_id: object, result: object) -> dict[str, Any]:
    return {'jsonrpc': '2.0', 'id': req_id, 'result': result}


def _err(req_id: object, code: int, message: str) -> dict[str, Any]:
    return {'jsonrpc': '2.0', 'id': req_id, 'error': {'code': code, 'message': message}}


async def _call_tool(name: str, args: dict[str, Any], request: Request) -> object:
    import json
    import types

    from app.services.runtime_services import get_orchestrator
    from app.services.tools.spawn_subagents_tool import executeSpawnSubagents
    from app.services.workstreams import list_workstreams

    orch = get_orchestrator(request.app)
    if name == 'harness_list_workstreams':
        return list_workstreams(as_str(args.get('sessionId'), ''))
    if name == 'harness_list_jobs':
        from app.services.harness_jobs import list_jobs

        return list_jobs(as_str(args.get('sessionId'), ''))
    if name == 'harness_cancel_job':
        from app.services.harness_jobs import cancel_job

        return await cancel_job(as_str(args.get('jobId'), ''))
    if name == 'harness_steer':
        tid = as_str(args.get('taskId'), '')
        if not orch.enqueueMailbox(tid, as_str(args.get('message'), '')):
            return {'status': 'error', 'error': 'task not running'}
        return {'status': 'queued', 'taskId': tid}
    session_id = as_str(args.get('sessionId'), '')
    session = types.SimpleNamespace(
        id=session_id, model='', agentId='', agent_id='', provider='', subagent_depth=0
    )
    if name == 'harness_spawn':
        items = [as_dict(i) if isinstance(i, dict) else {'goal': str(i)} for i in as_list(args.get('workItems'), [])]
        result = await executeSpawnSubagents(
            orch, session, items, mode='auto', background=bool(args.get('background', True))
        )
        return result
    if name == 'harness_continue':
        result = await executeSpawnSubagents(
            orch,
            session,
            [
                {
                    'goal': as_str(args.get('message'), ''),
                    'workstream': as_str(args.get('name'), ''),
                    'name': as_str(args.get('name'), ''),
                    'agentId': 'general',
                }
            ],
            mode='auto',
            background=True,
        )
        return result
    return json.dumps({'error': f'unknown tool {name}'})


@router.post('/mcp/harness')
async def harness_mcp(request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse(_err(None, -32600, 'invalid request'))
    req_id = body.get('id')
    method = as_str(body.get('method'), '')
    params = as_dict(body.get('params'), {})
    if method == 'initialize':
        return JSONResponse(
            _ok(
                req_id,
                {
                    'protocolVersion': '2024-11-05',
                    'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'august-harness', 'version': '1'},
                },
            )
        )
    if method == 'notifications/initialized':
        return JSONResponse({'jsonrpc': '2.0'})
    if method == 'tools/list':
        return JSONResponse(_ok(req_id, {'tools': _TOOLS}))
    if method == 'tools/call':
        name = as_str(params.get('name'), '')
        args = as_dict(params.get('arguments'), {})
        try:
            result = await _call_tool(name, args, request)
        except Exception as exc:
            return JSONResponse(_ok(req_id, {'content': [{'type': 'text', 'text': f'Error: {exc}'}], 'isError': True}))
        import json

        text = result if isinstance(result, str) else json.dumps(result, default=str)
        return JSONResponse(_ok(req_id, {'content': [{'type': 'text', 'text': text}]}))
    if method == 'ping':
        return JSONResponse(_ok(req_id, {}))
    return JSONResponse(_err(req_id, -32601, f'method not found: {method}'))
