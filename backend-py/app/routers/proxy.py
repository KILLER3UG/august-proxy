"""
Proxy routes — /v1/messages (Anthropic) and /v1/chat/completions (OpenAI).

Now delegates to the full adapter implementations for message translation,
tool call interception, and SSE streaming. Also wires traffic/activity
capture into the logger so the Observability section has live data:
start_request on entry, capture_request for the body, and either
end_request (non-streaming) or a stream-wrapping end_request (streaming).

All /v1/* endpoints are gated by ``requireGatewayKey`` so external clients
must authenticate with the ``GATEWAY_API_KEY`` Bearer token. The local SPA
is unaffected because it uses ``/api/*`` (workbench, sessions, etc.) instead
of ``/v1/*``.
"""
from __future__ import annotations
import time
from typing import AsyncIterator
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from app.adapters import anthropic as anthropicAdapter
from app.adapters import openai as openaiAdapter
from app.lib.gatewayAuth import requireGatewayKey
from app.providers import resolver as providerResolver
from app.services import logger as trafficLogger
router = APIRouter()

def _clientTypeFor(endpoint: str) -> str:
    """Map a proxy endpoint to the clientType the UI groups by."""
    if endpoint == 'messages':
        return 'anthropic'
    if endpoint == 'responses':
        return 'openai-responses'
    return 'openai'


def _emit(category: str, level: str, message: str, metadata: object = None) -> None:
    """Emit a structured log event for the Backend Monitor (snake_case categories)."""
    try:
        trafficLogger.emitLogEvent({'category': category, 'level': level, 'message': message, 'metadata': metadata})
    except Exception:
        pass

def _safeInt(v: object) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0

async def _trackRequest(endpoint: str, body: dict[str, object], request: Request):
    """Register a pending request and capture its body for observability.

    Returns the request id. The caller MUST call end_request (or wrap the
    stream) so the entry is finalized — otherwise it lingers in pending
    until the stale-cleanup sweep.
    """
    model = body.get('model', 'unknown')
    reqId = trafficLogger.startRequest({'model': model, 'provider': model, 'clientType': _clientTypeFor(endpoint), 'endpoint': f'/v1/{endpoint}', 'method': request.method if hasattr(request, 'method') else 'POST', 'path': f'/v1/{endpoint}', 'sessionId': body.get('sessionId') or body.get('session_id') or ''})
    trafficLogger.captureRequest(reqId, body)
    trafficLogger.logActivity('request_start', f'{_clientTypeFor(endpoint)} /v1/{endpoint} → {model}')
    _emit('proxy_incoming', 'info', f'{_clientTypeFor(endpoint)} /v1/{endpoint} → {model}', {
        'model': model,
        'endpoint': endpoint,
        'sessionId': body.get('sessionId') or body.get('session_id') or '',
    })
    return reqId

def _endNonStream(reqId: str, result: dict[str, object]) -> dict[str, object]:
    """Finalize a non-streaming request: capture response/tokens, end it."""
    if 'error' in result:
        trafficLogger.capture_error(reqId, str(result.get('error'))[:500])
        trafficLogger.capture_response(reqId, result)
        trafficLogger.endRequest(reqId, {'error': str(result.get('error'))})
        trafficLogger.logActivity('request_error', f"[{reqId}] {result.get('error')}")
        _emit('error', 'error', f'Proxy request failed: {result.get("error")}', {'reqId': reqId})
        return result
    trafficLogger.capture_response(reqId, result)
    usage = result.get('usage') or {}
    inT = _safeInt(usage.get('prompt_tokens') or usage.get('input_tokens'))
    outT = _safeInt(usage.get('completion_tokens') or usage.get('output_tokens'))
    if inT or outT:
        trafficLogger.capture_tokens(reqId, inT, outT)
    trafficLogger.endRequest(reqId, {'usage': usage})
    trafficLogger.logActivity('request_complete', f"[{reqId}] {_clientTypeFor('')} ok ({inT + outT} tok)")
    _emit('proxy_upstream', 'info', f'Upstream complete ({inT + outT} tokens)', {
        'reqId': reqId,
        'inputTokens': inT,
        'outputTokens': outT,
        'model': result.get('model', 'unknown'),
    })
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
        raise
    else:
        if inT or outT:
            trafficLogger.capture_tokens(reqId, inT, outT)
        trafficLogger.endRequest(reqId, {'usage': {'input_tokens': inT, 'output_tokens': outT}})
        trafficLogger.logActivity('request_complete', f'[{reqId}] stream ok ({inT + outT} tok)')
    finally:
        pass

@router.post('/v1/messages')
async def anthropicMessages(request: Request, _auth: bool=Depends(requireGatewayKey)):
    """Anthropic Messages API proxy.

    Delegates to the Anthropic adapter which handles:
    - Model alias resolution
    - System prompt normalization
    - Message format translation (Anthropic ↔ OpenAI)
    - SSE streaming (native and converted)
    - Tool call interception and managed execution
    """
    body = await request.json()
    reqId = await _trackRequest('messages', body, request)
    result, headers = await anthropicAdapter.handle_messages(body, request)
    if isinstance(result, dict):
        return _endNonStream(reqId, result)
    if isinstance(result, AsyncIterator):
        return StreamingResponse(_wrapStream(reqId, result), media_type='text/event-stream', headers=headers or {'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'})
    trafficLogger.endRequest(reqId, {})
    return result

@router.post('/v1/chat/completions')
async def openaiChat(request: Request, _auth: bool=Depends(requireGatewayKey)):
    """OpenAI Chat Completions API proxy.

    Delegates to the OpenAI adapter which handles:
    - Provider resolution for any model
    - SSE streaming with tool call interception
    - Multi-round tool resolution
    - Session derivation
    """
    body = await request.json()
    reqId = await _trackRequest('chat/completions', body, request)
    result, headers = await openaiAdapter.handle_chat_completions(body, request)
    if isinstance(result, dict):
        return _endNonStream(reqId, result)
    if isinstance(result, AsyncIterator):
        return StreamingResponse(_wrapStream(reqId, result), media_type='text/event-stream', headers=headers or {'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'})
    trafficLogger.endRequest(reqId, {})
    return result

@router.post('/v1/responses')
async def openaiResponses(request: Request, _auth: bool=Depends(requireGatewayKey)):
    """OpenAI Responses API proxy.

    Translates the chat completion response to the Responses API format.
    Uses the same OpenAI adapter as /v1/chat/completions.
    """
    body = await request.json()
    body['_endpoint'] = 'responses'
    reqId = await _trackRequest('responses', body, request)
    result, headers = await openaiAdapter.handle_chat_completions(body, request)
    if isinstance(result, dict):
        if 'error' in result:
            return _endNonStream(reqId, result)
        translated = _translateToResponsesFormat(result)
        return _endNonStream(reqId, translated)
    if isinstance(result, AsyncIterator):
        return StreamingResponse(_wrapStream(reqId, result), media_type='text/event-stream', headers=headers or {'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'})
    trafficLogger.endRequest(reqId, {})
    return result

def _translateToResponsesFormat(chatCompletion: dict) -> dict:
    """Translate a Chat Completions response to Responses API format."""
    import uuid
    import time
    choices = chatCompletion.get('choices', [])
    choice = choices[0] if choices else {}
    message = choice.get('message', {})
    finishReason = choice.get('finish_reason', 'stop')
    usage = chatCompletion.get('usage', {})
    outputItems = []
    reasoning = message.get('reasoning') or message.get('reasoning_content', '')
    if reasoning:
        outputItems.append({'id': f'item_{uuid.uuid4().hex[:8]}', 'type': 'reasoning', 'status': 'completed', 'content': reasoning})
    for tc in message.get('tool_calls', []):
        outputItems.append({'id': tc.get('id', f'call_{uuid.uuid4().hex[:8]}'), 'type': 'function_call', 'status': 'completed', 'name': tc.get('function', {}).get('name', ''), 'arguments': tc.get('function', {}).get('arguments', ''), 'call_id': tc.get('id', '')})
    content = message.get('content', '')
    if content:
        outputItems.append({'id': f'msg_{uuid.uuid4().hex[:8]}', 'type': 'message', 'status': 'completed', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': content}]})
    return {'id': f'resp_{uuid.uuid4().hex[:12]}', 'object': 'response', 'created_at': int(time.time()), 'status': 'completed', 'model': chatCompletion.get('model', ''), 'output': outputItems, 'usage': {'input_tokens': usage.get('prompt_tokens', 0), 'output_tokens': usage.get('completion_tokens', 0), 'total_tokens': usage.get('total_tokens', 0)}}

@router.get('/v1/models')
async def listModels(_auth: bool=Depends(requireGatewayKey)):
    """List available models from all configured providers."""
    providers = providerResolver.listAvailable()
    models = []
    for p in providers:
        name = p.get('name', '')
        modelProfiles = p.get('model_profiles', {})
        for modelId, profile in modelProfiles.items():
            if modelId == '*':
                continue
            models.append({'id': modelId, 'provider': name, 'object': 'model', 'context_window': profile.get('contextWindow', 0), 'max_output_tokens': profile.get('maxOutputTokens', 0)})
    return {'object': 'list', 'data': models}