"""
August Live — voice + command execution router.

Live reuses workbench sessions (same store as chat). No fake session ids.
STT/TTS return clear errors when providers are not configured.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
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
    """Run a Live turn through the workbench chat path (non-stream summary).

    Full SSE streaming is available via ``POST /api/workbench/chat`` + stream.
    This endpoint returns a synchronous text summary for voice UIs that poll.
    """
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
    answer = ''
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
        if provider and model:
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
                result = {'error': 'unsupported provider'}
            if isinstance(result, dict) and not result.get('error'):
                answer = str(result.get('text') or result.get('content') or '')
                if not answer and isinstance(result.get('content'), list):
                    answer = extract_text(
                        [b for b in result['content'] if isinstance(b, dict)]  # type: ignore[index]
                    )
    except Exception:
        answer = ''

    if not answer:
        # Honest partial: session is real; model reply needs API key.
        answer = (
            f'Heard: {transcript[:200]}. '
            'Configure a provider API key for full Live model replies, '
            'or use POST /api/workbench/chat for streaming chat.'
        )

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


@router.post('/stt')
async def liveStt(body: SttBody) -> dict[str, object]:
    """Speech-to-text — honest fail when no STT provider is configured."""
    from app.services.config_service import getConfig
    from app.json_narrowing import as_dict

    cfg = getConfig()
    live = as_dict(cfg.get('live')) if cfg.get('live') is not None else {}
    stt = as_dict(live.get('stt')) if live.get('stt') is not None else {}
    if not stt.get('provider') and not stt.get('enabled'):
        raise HTTPException(
            status_code=501,
            detail='STT not configured. Set live.stt in config or use browser Web Speech and POST /api/live/turn with transcript.',
        )
    # Provider-specific STT is not fully wired; refuse silent success.
    raise HTTPException(
        status_code=501,
        detail=f"STT provider '{stt.get('provider')}' is configured but server-side STT is not implemented yet. Use browser STT → /api/live/turn.",
    )


@router.post('/tts')
async def liveTts(body: TtsBody) -> dict[str, object]:
    """Text-to-speech — honest fail when no TTS provider is configured."""
    from app.services.config_service import getConfig
    from app.json_narrowing import as_dict

    if not (body.text or '').strip():
        raise HTTPException(status_code=400, detail='text is required')
    cfg = getConfig()
    live = as_dict(cfg.get('live')) if cfg.get('live') is not None else {}
    tts = as_dict(live.get('tts')) if live.get('tts') is not None else {}
    if not tts.get('provider') and not tts.get('enabled'):
        raise HTTPException(
            status_code=501,
            detail='TTS not configured. Use browser speechSynthesis or set live.tts in config.',
        )
    raise HTTPException(
        status_code=501,
        detail=f"TTS provider '{tts.get('provider')}' is configured but server-side TTS is not implemented yet.",
    )
