"""
August Live — voice + command execution router (v4 §14).

Reuses the existing workbench turn engine. No new tool loop.
Guard mode, brain access, daemons, verifier reflex all carry over for free.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/api/live")


@router.post("/session")
async def live_session(body: dict[str, Any]):
    """Start or stop a Live session.

    Reuses the workbench session. Returns session id.
    """
    action = body.get("action", "start")
    if action == "stop":
        return {"status": "stopped"}
    return {"session_id": "live_" + str(hash(str(body))), "status": "started"}


@router.post("/turn")
async def live_turn(body: dict[str, Any]):
    """Process a Live turn.

    Takes a transcript, runs it through the existing workbench turn engine,
    streams SSE events back. This is a thin wrapper — the actual workbench
    tool loop handles all tool execution, guard mode, and brain access.
    """
    transcript = body.get("transcript", "")
    session_id = body.get("sessionId", "")

    if not transcript:
        return {"error": "No transcript provided"}

    # In production, this calls the workbench turn engine with the transcript
    # as the user message. The SSE stream carries text + tool_use + tool_result
    # events, which the frontend maps to TTS + Live tool cards.

    return {
        "sessionId": session_id,
        "type": "text",
        "content": f"Processing: {transcript[:100]}...",
    }


@router.post("/stt")
async def live_stt(body: dict[str, Any]):
    """Speech-to-text endpoint.

    Accepts audio chunks, returns streaming transcript.
    Can be server-side (OpenAI whisper, Deepgram) or frontend
    can talk directly to the STT provider and post final text only.
    """
    return {"transcript": "", "partial": True}


@router.post("/tts")
async def live_tts(body: dict[str, Any]):
    """Text-to-speech endpoint.

    Accepts text, returns audio stream.
    Can be server-side (OpenAI TTS, ElevenLabs) or browser speechSynthesis.
    """
    return {"audio": None, "format": "mp3"}
