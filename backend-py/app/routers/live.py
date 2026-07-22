"""
August Live — voice + command execution router.

Live reuses workbench sessions (same store as chat). No fake session ids.
STT/TTS use real OpenAI-compatible providers when configured in Live settings.
"""

from __future__ import annotations

import base64

from fastapi import APIRouter, File, HTTPException, UploadFile
from app.json_narrowing import as_int, as_list
from app.models.camel_base import CamelModel
from app.services.workbench import workbench as wb

router = APIRouter(prefix='/api/live')


class LiveSessionBody(CamelModel):
    action: str = 'start'
    session_id: str = ''
    provider: str = ''
    agent_id: str = ''


class LiveTurnBody(CamelModel):
    transcript: str = ''
    session_id: str = ''
    provider: str = ''
    agent_id: str = ''


class SttBody(CamelModel):
    audio_base64: str = ''
    format: str = 'webm'


class TtsBody(CamelModel):
    text: str = ''
    voice: str = ''


@router.post('/session')
async def liveSession(body: LiveSessionBody) -> dict[str, object]:
    """Start or stop a Live session on a real workbench session."""
    action = (body.action or 'start').lower()
    if action == 'stop':
        if body.session_id:
            session = wb.getWorkbenchSession(body.session_id)
            if session:
                session.status = 'idle'
                try:
                    wb.saveSessions()
                except Exception:
                    pass
        return {'status': 'stopped', 'sessionId': body.session_id or None}

    if body.session_id:
        existing = wb.getWorkbenchSession(body.session_id)
        if existing:
            return {
                'sessionId': existing.id,
                'status': 'started',
                'guardMode': existing.guardMode,
            }

    session = wb.createWorkbenchSession(
        provider=body.provider or '',
        agentId=body.agent_id or 'build',
        guardMode='ask',
    )
    session.metadata = dict(session.metadata or {})
    session.metadata['live'] = True
    try:
        wb.saveSessions()
    except Exception:
        pass
    return {
        'sessionId': session.id,
        'status': 'started',
        'guardMode': session.guardMode,
    }


@router.post('/turn')
async def liveTurn(body: LiveTurnBody) -> dict[str, object]:
    """Run a Live turn through the workbench chat path (non-stream summary)."""
    transcript = (body.transcript or '').strip()
    if not transcript:
        raise HTTPException(status_code=400, detail='transcript is required')

    session_id = body.session_id
    if not session_id or not wb.getWorkbenchSession(session_id):
        created = wb.createWorkbenchSession(
            provider=body.provider or '',
            agentId=body.agent_id or 'build',
            guardMode='ask',
        )
        session_id = created.id

    session = wb.getWorkbenchSession(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail='Session not found')

    try:
        from app.services.workbench.providers import (
            resolve_chat_llm,
            is_anthropic_provider,
            is_openai_provider,
            call_anthropic_workbench,
            call_openai_workbench,
            extract_text,
        )

        provider, model = resolve_chat_llm(
            model=session.model or '',
            model_provider=session.provider or body.provider or '',
            session_provider=session.provider or body.provider or '',
            session_model=session.model or '',
        )
        if not provider or not model:
            raise HTTPException(
                status_code=503,
                detail=(
                    'No Live provider/model configured. '
                    'Set an active provider with an API key, or use Workbench chat.'
                ),
            )
        session.model = model
        pname = str(provider.get('name') or provider.get('id') or '')
        if pname:
            session.provider = pname
        msgs: list[dict[str, object]] = []
        for m in (session.messages or [])[-6:]:
            if isinstance(m, dict) and m.get('role') in ('user', 'assistant') and m.get('content'):
                msgs.append({'role': m['role'], 'content': str(m['content'])[:1500]})
        msgs.append({'role': 'user', 'content': transcript})
        system_text = (
            'You are August Live voice mode. Answer concisely for spoken delivery. '
            'No tools. Prefer short sentences.'
        )
        if is_anthropic_provider(provider):
            result = await call_anthropic_workbench(
                messages=msgs, system_text=system_text, model=model,
                tools=[], effort='low', provider=provider,
            )
        elif is_openai_provider(provider):
            result = await call_openai_workbench(
                messages=msgs, system_text=system_text, model=model,
                tools=[], effort='low', provider=provider,
            )
        else:
            raise HTTPException(status_code=502, detail='Unsupported Live provider type')
        if isinstance(result, dict) and result.get('error'):
            raise HTTPException(status_code=502, detail=str(result.get('error')))
        answer = ''
        if isinstance(result, dict):
            answer = str(result.get('text') or result.get('content') or '')
            if not answer and isinstance(result.get('content'), list):
                answer = extract_text(
                    [b for b in as_list(result.get('content'), []) if isinstance(b, dict)]
                )
        if not (answer or '').strip():
            raise HTTPException(status_code=502, detail='Live model returned an empty reply')
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'Live model call failed: {exc}') from exc

    from datetime import datetime, timezone

    session.messages.append({'role': 'user', 'content': transcript})
    session.messages.append({'role': 'assistant', 'content': answer})
    session.messageCount = len(session.messages)
    session.updatedAt = datetime.now(timezone.utc).isoformat()
    try:
        wb.saveSessions()
    except Exception:
        pass

    return {
        'sessionId': session_id,
        'type': 'text',
        'content': answer,
        'workbenchStream': f'/api/workbench/chat/stream?sessionId={session_id}',
    }


async def _stt_from_bytes(audio: bytes, filename: str = 'audio.webm', content_type: str = 'audio/webm') -> dict[str, object]:
    from app.services.live_speech import transcribe_audio

    result = await transcribe_audio(audio, filename=filename, content_type=content_type)
    if not result.get('ok'):
        raise HTTPException(status_code=as_int(result.get('status'), 501), detail=str(result.get('error') or 'STT failed'))
    return {
        'transcript': result.get('transcript') or '',
        'partial': False,
        'model': result.get('model'),
        'provider': result.get('provider'),
    }


@router.post('/stt')
async def liveSttJson(body: SttBody) -> dict[str, object]:
    """Speech-to-text from base64 audio (JSON body)."""
    if not (body.audio_base64 or '').strip():
        raise HTTPException(status_code=400, detail='audio_base64 is required (or POST multipart file to /api/live/stt/upload)')
    try:
        raw = base64.b64decode(body.audio_base64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'invalid base64 audio: {exc}') from exc
    fmt = (body.format or 'webm').lstrip('.')
    return await _stt_from_bytes(raw, filename=f'audio.{fmt}', content_type=f'audio/{fmt}')


@router.post('/stt/upload')
async def liveSttUpload(audio: UploadFile = File(...)) -> dict[str, object]:
    """Speech-to-text from multipart file upload (browser MediaRecorder)."""
    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail='empty audio upload')
    filename = audio.filename or 'audio.webm'
    content_type = audio.content_type or 'audio/webm'
    return await _stt_from_bytes(raw, filename=filename, content_type=content_type)


@router.post('/tts')
async def liveTts(body: TtsBody) -> dict[str, object]:
    """Text-to-speech — real OpenAI-compatible provider when configured."""
    from app.services.live_speech import synthesize_speech

    if not (body.text or '').strip():
        raise HTTPException(status_code=400, detail='text is required')
    result = await synthesize_speech(body.text.strip(), voice=body.voice or '')
    if not result.get('ok'):
        raise HTTPException(status_code=as_int(result.get('status'), 501), detail=str(result.get('error') or 'TTS failed'))
    return {
        'audio': result.get('audio'),
        'format': result.get('format') or 'mp3',
        'model': result.get('model'),
        'voice': result.get('voice'),
        'provider': result.get('provider'),
    }
