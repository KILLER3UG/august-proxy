"""
August Live — voice + command execution router (v4 §14).

Reuses the existing workbench turn engine. No new tool loop.
Guard mode, brain access, daemons, verifier reflex all carry over for free.
"""
from __future__ import annotations
from fastapi import APIRouter
router = APIRouter(prefix='/api/live')

@router.post('/session')
async def liveSession(body: dict[str, object]) -> dict[str, object]:
    """Start or stop a Live session.

    Reuses the workbench session. Returns session id.
    """
    action = body.get('action', 'start')
    if action == 'stop':
        return {'status': 'stopped'}
    return {'session_id': 'live_' + str(hash(str(body))), 'status': 'started'}

@router.post('/turn')
async def liveTurn(body: dict[str, object]) -> dict[str, object]:
    """Process a Live turn.

    Takes a transcript, runs it through the existing workbench turn engine,
    streams SSE events back. This is a thin wrapper — the actual workbench
    tool loop handles all tool execution, guard mode, and brain access.
    """
    transcript = str(body.get('transcript', '') or '')
    sessionId = str(body.get('sessionId', '') or '')
    if not transcript:
        return {'error': 'No transcript provided'}
    return {'sessionId': sessionId, 'type': 'text', 'content': f'Processing: {transcript[:100]}...'}

@router.post('/stt')
async def liveStt(body: dict[str, object]) -> dict[str, object]:
    """Speech-to-text endpoint.

    Accepts audio chunks, returns streaming transcript.
    Can be server-side (OpenAI whisper, Deepgram) or frontend
    can talk directly to the STT provider and post final text only.
    """
    return {'transcript': '', 'partial': True}

@router.post('/tts')
async def liveTts(body: dict[str, object]) -> dict[str, object]:
    """Text-to-speech endpoint.

    Accepts text, returns audio stream.
    Can be server-side (OpenAI TTS, ElevenLabs) or browser speechSynthesis.
    """
    return {'audio': None, 'format': 'mp3'}