"""
Proxy routes — /v1/messages (Anthropic) and /v1/chat/completions (OpenAI).

Now delegates to the full adapter implementations for message translation,
tool call interception, and SSE streaming. Also wires traffic/activity
capture into the logger so the Observability section has live data:
start_request on entry, capture_request for the body, and either
end_request (non-streaming) or a stream-wrapping end_request (streaming).

All /v1/* endpoints are gated by ``require_gateway_key`` so external clients
must authenticate with the ``GATEWAY_API_KEY`` Bearer token. The local SPA
is unaffected because it uses ``/api/*`` (workbench, sessions, etc.) instead
of ``/v1/*``.
"""

from __future__ import annotations

import time
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.adapters import anthropic as anthropicAdapter
from app.adapters import openai as openaiAdapter
from app.json_narrowing import as_dict, as_int, as_list, as_str
from app.lib.gateway_auth import require_gateway_key
from app.providers import resolver as providerResolver
from app.services import config_service
from app.services import logger as trafficLogger
from app.services.feature_flow import emit_feature_flow

router = APIRouter()


def _clientTypeFor(endpoint: str) -> str:
    """Map a proxy endpoint to the clientType the UI groups by."""
    if endpoint == 'messages':
        return 'anthropic'
    if endpoint == 'responses':
        return 'openai-responses'
    return 'openai'


async def _readJsonBody(request: Request, endpoint: str) -> dict[str, object] | JSONResponse:
    """Read and parse the request JSON body, returning a clean 400 on failure.

    ``request.json()`` raises ``json.JSONDecodeError`` on malformed input; without
    handling, FastAPI surfaces that as a 500 and never records the request. We catch
    it so callers get a well-formed error and observability still fires.
    """
    try:
        return await request.json()
    except Exception as exc:  # malformed JSON / empty body
        trafficLogger.emitLogEvent(
            {
                'category': 'proxy_error',
                'level': 'warn',
                'message': f'[{endpoint}] malformed request JSON: {exc}',
            }
        )
        return JSONResponse(
            status_code=400,
            content={'error': {'code': 'invalid_json', 'message': 'Request body must be valid JSON'}},
        )


def _emit(category: str, level: str, message: str, metadata: object = None) -> None:
    """Emit a structured log event for the Backend Monitor (snake_case categories)."""
    try:
        trafficLogger.emitLogEvent({'category': category, 'level': level, 'message': message, 'metadata': metadata})
    except Exception:
        pass


def _inject_aug_enabled() -> bool:
    """Read ``injectAugOnProxy`` from config.json (default False)."""
    try:
        cfg = config_service.getConfig()
        return bool(cfg.get('injectAugOnProxy') or cfg.get('inject_aug_on_proxy'))
    except Exception:
        return False


def _maybe_inject_aug_into_body(body: dict[str, object], endpoint: str) -> dict[str, object]:
    """When enabled, append AUG.md body into the proxy system prompt.

    Default off — does not change proxy behaviour until the user toggles
    Settings → API Access → Inject AUG.md on proxy path.
    """
    if not _inject_aug_enabled():
        return body
    try:
        from app.services import aug_directive_service

        loaded = aug_directive_service.load(None)
        if not loaded:
            emit_feature_flow(
                feature='proxy',
                stage='inject',
                summary='AUG inject enabled but AUG.md not found',
                status='ok',
                meta={'endpoint': endpoint, 'injected': False},
            )
            return body
        aug_body = str(loaded.get('body') or '').strip()
        if not aug_body:
            return body
        block = f'<aug_directives>\n{aug_body}\n</aug_directives>'
        out = dict(body)
        if endpoint == 'messages':
            # Anthropic: system can be string or list of blocks
            system = out.get('system')
            if isinstance(system, str):
                out['system'] = system + '\n\n' + block
            elif isinstance(system, list):
                out['system'] = list(system) + [{'type': 'text', 'text': block}]
            else:
                out['system'] = [{'type': 'text', 'text': block}]
        else:
            # OpenAI chat: inject/append system message
            messages = as_list(out.get('messages'), [])
            if messages and isinstance(messages[0], dict) and messages[0].get('role') == 'system':
                first = dict(messages[0])
                content = first.get('content')
                if isinstance(content, str):
                    first['content'] = content + '\n\n' + block
                else:
                    first['content'] = block
                messages[0] = first
            else:
                messages.insert(0, {'role': 'system', 'content': block})
            out['messages'] = messages
        emit_feature_flow(
            feature='proxy',
            stage='inject',
            summary='Injected AUG.md into proxy system prompt',
            status='ok',
            meta={'endpoint': endpoint, 'injected': True, 'chars': len(aug_body)},
        )
        return out
    except Exception as exc:
        emit_feature_flow(
            feature='proxy',
            stage='inject',
            summary=f'AUG inject failed: {exc}',
            status='error',
            error=str(exc)[:300],
            meta={'endpoint': endpoint},
        )
        return body


def _safeInt(v: object) -> int:
    try:
        return int(v) if isinstance(v, (int, float, str)) else 0
    except (TypeError, ValueError):
        return 0


async def _trackRequest(endpoint: str, body: dict[str, object], request: Request):
    """Register a pending request and capture its body for observability.

    Returns the request id. The caller MUST call end_request (or wrap the
    stream) so the entry is finalized — otherwise it lingers in pending
    until the stale-cleanup sweep.
    """
    model = as_str(body.get('model'), 'unknown')
    reqId = trafficLogger.startRequest(
        {
            'model': model,
            'provider': model,
            'clientType': _clientTypeFor(endpoint),
            'endpoint': f'/v1/{endpoint}',
            'method': request.method if hasattr(request, 'method') else 'POST',
            'path': f'/v1/{endpoint}',
            'sessionId': as_str(body.get('sessionId')) or as_str(body.get('session_id')) or '',
        }
    )
    trafficLogger.captureRequest(reqId, body)
    method = request.method if hasattr(request, 'method') else 'POST'
    path = f'/v1/{endpoint}'
    trafficLogger.logActivity('request_start', f'{_clientTypeFor(endpoint)} {path} → {model}')
    _emit(
        'proxy_incoming',
        'info',
        f'{method} {path} → {model}',
        {
            'model': model,
            'endpoint': endpoint,
            'method': method,
            'path': path,
            'statusCode': None,
            'sessionId': as_str(body.get('sessionId')) or as_str(body.get('session_id')) or '',
        },
    )
    emit_feature_flow(
        feature='proxy',
        stage='start',
        summary=f'{_clientTypeFor(endpoint)} /v1/{endpoint} → {model}',
        status='running',
        trace_id=reqId,
        meta={'model': model, 'endpoint': endpoint},
    )
    emit_feature_flow(
        feature='proxy',
        stage='route',
        summary=f'Routed to {model}',
        status='running',
        trace_id=reqId,
        meta={'model': model},
    )
    return reqId


def _endNonStream(reqId: str, result: dict[str, object]) -> dict[str, object]:
    """Finalize a non-streaming request: capture response/tokens, end it."""
    if 'error' in result:
        trafficLogger.capture_error(reqId, as_str(result.get('error'))[:500])
        trafficLogger.capture_response(reqId, result)
        trafficLogger.endRequest(reqId, {'error': as_str(result.get('error'))})
        trafficLogger.logActivity('request_error', f'[{reqId}] {result.get("error")}')
        err_code = _safeInt(result.get('status') or result.get('status_code') or 502) or 502
        _emit(
            'error',
            'error',
            f'HTTP {err_code} · Proxy request failed: {result.get("error")}',
            {
                'reqId': reqId,
                'statusCode': err_code,
                'method': 'POST',
                'path': '/v1/*',
            },
        )
        emit_feature_flow(
            feature='proxy',
            stage='error',
            summary=f'Proxy error: {result.get("error")}',
            status='error',
            trace_id=reqId,
            error=as_str(result.get('error'))[:500],
        )
        return result
    trafficLogger.capture_response(reqId, result)
    usage = as_dict(result.get('usage'), {})
    inT = _safeInt(usage.get('prompt_tokens') or usage.get('input_tokens'))
    outT = _safeInt(usage.get('completion_tokens') or usage.get('output_tokens'))
    if inT or outT:
        trafficLogger.capture_tokens(reqId, inT, outT)
    trafficLogger.endRequest(reqId, {'usage': usage})
    trafficLogger.logActivity('request_complete', f'[{reqId}] {_clientTypeFor("")} ok ({inT + outT} tok)')
    model = as_str(result.get('model'), 'unknown')
    _emit(
        'proxy_upstream',
        'info',
        f'HTTP 200 OK · Upstream complete ({inT + outT} tokens) · {model}',
        {
            'reqId': reqId,
            'inputTokens': inT,
            'outputTokens': outT,
            'model': model,
            'statusCode': 200,
            'method': 'POST',
            'path': '/v1/*',
        },
    )
    emit_feature_flow(
        feature='proxy',
        stage='upstream',
        summary=f'Upstream complete ({inT + outT} tokens)',
        status='ok',
        trace_id=reqId,
        meta={'inputTokens': inT, 'outputTokens': outT, 'statusCode': 200},
    )
    emit_feature_flow(
        feature='proxy',
        stage='end',
        summary='Proxy request complete · 200 OK',
        status='ok',
        trace_id=reqId,
    )
    return result


async def _wrapStream(reqId: str, stream: AsyncIterator[str]) -> AsyncIterator[str]:
    """Wrap an SSE stream so completion finalizes the request entry.

    Accumulates a lightweight usage snapshot from any `message_delta` /
    `usage` events that carry token counts, then calls end_request when the
    stream is exhausted or the client disconnects.
    """
    inT = 0
    outT = 0
    try:
        async for chunk in stream:
            try:
                if isinstance(chunk, str):
                    lower = chunk
                    if '"usage"' in lower or '"message_delta"' in lower:
                        import re

                        mIn = re.search('"input_tokens"[:\\s]+(\\d+)', lower)
                        mOut = re.search('"output_tokens"[:\\s]+(\\d+)', lower)
                        if mIn:
                            inT = max(inT, int(mIn.group(1)))
                        if mOut:
                            outT = max(outT, int(mOut.group(1)))
            except Exception:
                pass
            yield chunk
    except Exception as exc:
        trafficLogger.capture_error(reqId, str(exc)[:500])
        trafficLogger.endRequest(reqId, {'error': str(exc)})
        trafficLogger.logActivity('request_error', f'[{reqId}] stream error: {exc}')
        _emit(
            'error',
            'error',
            f'HTTP 502 · Stream error: {exc}',
            {'reqId': reqId, 'statusCode': 502, 'method': 'POST', 'path': '/v1/*'},
        )
        emit_feature_flow(
            feature='proxy',
            stage='error',
            summary=f'Stream error: {exc}',
            status='error',
            trace_id=reqId,
            error=str(exc)[:500],
        )
        raise
    else:
        if inT or outT:
            trafficLogger.capture_tokens(reqId, inT, outT)
        trafficLogger.endRequest(reqId, {'usage': {'input_tokens': inT, 'output_tokens': outT}})
        trafficLogger.logActivity('request_complete', f'[{reqId}] stream ok ({inT + outT} tok)')
        _emit(
            'proxy_upstream',
            'info',
            f'HTTP 200 OK · Stream complete ({inT + outT} tokens)',
            {
                'reqId': reqId,
                'inputTokens': inT,
                'outputTokens': outT,
                'statusCode': 200,
                'method': 'POST',
                'path': '/v1/*',
            },
        )
        emit_feature_flow(
            feature='proxy',
            stage='stream',
            summary=f'Stream complete ({inT + outT} tokens)',
            status='ok',
            trace_id=reqId,
            meta={'inputTokens': inT, 'outputTokens': outT, 'statusCode': 200},
        )
        emit_feature_flow(
            feature='proxy',
            stage='end',
            summary='Proxy stream complete · 200 OK',
            status='ok',
            trace_id=reqId,
        )
    finally:
        pass


@router.post('/v1/messages')
async def anthropicMessages(request: Request, _auth: bool = Depends(require_gateway_key)):
    """Anthropic Messages API proxy.

    Delegates to the Anthropic adapter which handles:
    - Model alias resolution
    - System prompt normalization
    - Message format translation (Anthropic ↔ OpenAI)
    - SSE streaming (native and converted)
    - Tool call interception and managed execution
    """
    body = await _readJsonBody(request, 'messages')
    if isinstance(body, JSONResponse):
        return body
    body = _maybe_inject_aug_into_body(body, 'messages')
    reqId = await _trackRequest('messages', body, request)
    emit_feature_flow(
        feature='proxy',
        stage='translate',
        summary='Anthropic message path',
        status='running',
        trace_id=reqId,
    )
    result, headers = await anthropicAdapter.handleMessages(body, request)
    if isinstance(result, dict):
        return _endNonStream(reqId, result)
    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            _wrapStream(reqId, result),
            media_type='text/event-stream',
            headers=headers or {'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
        )
    trafficLogger.endRequest(reqId, {})
    return result


@router.post('/v1/chat/completions')
async def openaiChat(request: Request, _auth: bool = Depends(require_gateway_key)):
    """OpenAI Chat Completions API proxy.

    Delegates to the OpenAI adapter which handles:
    - Provider resolution for any model
    - SSE streaming with tool call interception
    - Multi-round tool resolution
    - Session derivation
    """
    body = await _readJsonBody(request, 'chat/completions')
    if isinstance(body, JSONResponse):
        return body
    body = _maybe_inject_aug_into_body(body, 'chat/completions')
    reqId = await _trackRequest('chat/completions', body, request)
    emit_feature_flow(
        feature='proxy',
        stage='translate',
        summary='OpenAI chat completions path',
        status='running',
        trace_id=reqId,
    )
    result, headers = await openaiAdapter.handleChatCompletions(body, request)
    if isinstance(result, dict):
        return _endNonStream(reqId, result)
    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            _wrapStream(reqId, result),
            media_type='text/event-stream',
            headers=headers or {'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
        )
    trafficLogger.endRequest(reqId, {})
    return result


@router.post('/v1/responses')
async def openaiResponses(request: Request, _auth: bool = Depends(require_gateway_key)):
    """OpenAI Responses API proxy.

    Translates the chat completion response to the Responses API format.
    Uses the same OpenAI adapter as /v1/chat/completions.
    """
    body = await _readJsonBody(request, 'responses')
    if isinstance(body, JSONResponse):
        return body
    body['_endpoint'] = 'responses'
    reqId = await _trackRequest('responses', body, request)
    result, headers = await openaiAdapter.handleChatCompletions(body, request)
    if isinstance(result, dict):
        if 'error' in result:
            return _endNonStream(reqId, result)
        translated = _translateToResponsesFormat(result)
        return _endNonStream(reqId, translated)
    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            _wrapStream(reqId, result),
            media_type='text/event-stream',
            headers=headers or {'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
        )
    trafficLogger.endRequest(reqId, {})
    return result


def _translateToResponsesFormat(chatCompletion: dict) -> dict:
    """Translate a Chat Completions response to Responses API format."""
    import uuid

    choices = as_list(chatCompletion.get('choices'), [])
    choice = as_dict(choices[0] if choices else None, {})
    message = as_dict(choice.get('message'), {})
    usage = as_dict(chatCompletion.get('usage'), {})
    outputItems: list[dict[str, object]] = []
    reasoning = as_str(message.get('reasoning')) or as_str(message.get('reasoning_content'), '')
    if reasoning:
        outputItems.append(
            {'id': f'item_{uuid.uuid4().hex[:8]}', 'type': 'reasoning', 'status': 'completed', 'content': reasoning}
        )
    for tc_raw in as_list(message.get('tool_calls'), []):
        tc = as_dict(tc_raw)
        func = as_dict(tc.get('function'), {})
        outputItems.append(
            {
                'id': as_str(tc.get('id'), f'call_{uuid.uuid4().hex[:8]}'),
                'type': 'function_call',
                'status': 'completed',
                'name': as_str(func.get('name'), ''),
                'arguments': as_str(func.get('arguments'), ''),
                'call_id': as_str(tc.get('id'), ''),
            }
        )
    content = as_str(message.get('content'), '')
    if content:
        outputItems.append(
            {
                'id': f'msg_{uuid.uuid4().hex[:8]}',
                'type': 'message',
                'status': 'completed',
                'role': 'assistant',
                'content': [{'type': 'output_text', 'text': content}],
            }
        )
    return {
        'id': f'resp_{uuid.uuid4().hex[:12]}',
        'object': 'response',
        'created_at': int(time.time()),
        'status': 'completed',
        'model': as_str(chatCompletion.get('model'), ''),
        'output': outputItems,
        'usage': {
            'input_tokens': as_int(usage.get('prompt_tokens'), 0),
            'output_tokens': as_int(usage.get('completion_tokens'), 0),
            'total_tokens': as_int(usage.get('total_tokens'), 0),
        },
    }


@router.get('/v1/models')
async def listModels(_auth: bool = Depends(require_gateway_key)):
    """List available models from all configured providers."""
    providers = providerResolver.list_available()
    models = []
    for p in providers:
        name = as_str(p.get('name'), '')
        modelProfiles = as_dict(p.get('model_profiles'), {})
        for modelId, profile in modelProfiles.items():
            if modelId == '*':
                continue
            profileDict = as_dict(profile, {})
            models.append(
                {
                    'id': modelId,
                    'provider': name,
                    'object': 'model',
                    'context_window': as_int(profileDict.get('contextWindow'), 0),
                    'max_output_tokens': as_int(profileDict.get('maxOutputTokens'), 0),
                }
            )
    return {'object': 'list', 'data': models}
