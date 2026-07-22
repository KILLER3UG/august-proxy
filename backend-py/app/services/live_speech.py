"""Real server-side STT / TTS via OpenAI-compatible provider APIs.

Uses provider credentials from the providers store (same as chat).
Config: ``auxiliary.live.{sttProvider,sttModel,ttsProvider,ttsModel,ttsVoice}``.
"""

from __future__ import annotations

import base64
import logging

import httpx

from app.json_narrowing import as_dict, as_str
from app.services import live_config_service

logger = logging.getLogger(__name__)

DEFAULT_STT_MODEL = 'whisper-1'
DEFAULT_TTS_MODEL = 'tts-1'
DEFAULT_TTS_VOICE = 'alloy'


def _resolve_provider(provider_id: str) -> dict[str, object] | None:
    if not provider_id:
        return None
    try:
        from app.providers import resolver as provider_resolver

        # Prefer explicit id match in list, then resolve by name/model id
        for p in provider_resolver.list_available():
            if not isinstance(p, dict):
                continue
            pid = as_str(p.get('id') or p.get('name'))
            if pid.lower() == provider_id.lower() or as_str(p.get('name')).lower() == provider_id.lower():
                if p.get('api_key') or p.get('apiKey'):
                    return p
        # Fallback: first provider with a key that looks OpenAI-compatible
        for p in provider_resolver.list_available():
            if not isinstance(p, dict):
                continue
            mode = as_str(p.get('apiMode') or p.get('apiFormat'), 'openaiChat')
            if mode in ('openaiChat', 'openai', 'openaiResponses') and (p.get('api_key') or p.get('apiKey')):
                if not provider_id or provider_id.lower() in (
                    as_str(p.get('id')).lower(),
                    as_str(p.get('name')).lower(),
                    'openai',
                ):
                    return p
        if provider_id.lower() in ('openai', 'openai_api', 'default'):
            for p in provider_resolver.list_available():
                if p.get('api_key') or p.get('apiKey'):
                    mode = as_str(p.get('apiMode') or p.get('apiFormat'), 'openaiChat')
                    if 'openai' in mode.lower() or 'openai' in as_str(p.get('id')).lower():
                        return p
    except Exception:
        logger.debug('provider resolve failed', exc_info=True)
    return None


def _api_base_and_key(provider: dict[str, object]) -> tuple[str, str]:
    key = as_str(provider.get('api_key') or provider.get('apiKey'))
    base = as_str(provider.get('baseUrl') or provider.get('base_url'), 'https://api.openai.com/v1')
    base = base.rstrip('/')
    if base.endswith('/v1'):
        pass
    elif '/v1' not in base:
        base = base + '/v1'
    return base, key


async def transcribe_audio(
    audio_bytes: bytes,
    *,
    filename: str = 'audio.webm',
    content_type: str = 'audio/webm',
) -> dict[str, object]:
    """STT via OpenAI-compatible ``/audio/transcriptions`` (Whisper)."""
    live = live_config_service.getLiveConfig()
    provider_id = as_str(live.get('sttProvider'))
    model = as_str(live.get('sttModel')) or DEFAULT_STT_MODEL
    if not provider_id:
        return {
            'ok': False,
            'status': 501,
            'error': 'STT not configured. Set Live STT provider in Settings, or use browser Web Speech.',
        }
    provider = _resolve_provider(provider_id)
    if not provider:
        return {
            'ok': False,
            'status': 501,
            'error': f"STT provider '{provider_id}' has no API key. Add it under Providers.",
        }
    base, key = _api_base_and_key(provider)
    if not key:
        return {'ok': False, 'status': 501, 'error': 'STT provider API key missing'}
    url = f'{base}/audio/transcriptions'
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            files = {'file': (filename, audio_bytes, content_type)}
            data = {'model': model, 'response_format': 'json'}
            resp = await client.post(
                url,
                headers={'Authorization': f'Bearer {key}'},
                files=files,
                data=data,
            )
            if resp.status_code >= 400:
                return {
                    'ok': False,
                    'status': 502,
                    'error': f'STT upstream {resp.status_code}: {resp.text[:300]}',
                }
            payload = resp.json() if resp.headers.get('content-type', '').startswith('application/json') else {}
            text = as_str(as_dict(payload).get('text')) if isinstance(payload, dict) else str(payload)
            return {'ok': True, 'transcript': text, 'partial': False, 'model': model, 'provider': provider_id}
    except httpx.RequestError as exc:
        return {'ok': False, 'status': 502, 'error': f'STT request failed: {exc}'}


async def synthesize_speech(text: str, voice: str = '') -> dict[str, object]:
    """TTS via OpenAI-compatible ``/audio/speech``."""
    live = live_config_service.getLiveConfig()
    provider_id = as_str(live.get('ttsProvider'))
    model = as_str(live.get('ttsModel')) or DEFAULT_TTS_MODEL
    voice = voice or as_str(live.get('ttsVoice')) or DEFAULT_TTS_VOICE
    if not provider_id:
        return {
            'ok': False,
            'status': 501,
            'error': 'TTS not configured. Set Live TTS provider in Settings, or use browser speechSynthesis.',
        }
    provider = _resolve_provider(provider_id)
    if not provider:
        return {
            'ok': False,
            'status': 501,
            'error': f"TTS provider '{provider_id}' has no API key. Add it under Providers.",
        }
    base, key = _api_base_and_key(provider)
    if not key:
        return {'ok': False, 'status': 501, 'error': 'TTS provider API key missing'}
    url = f'{base}/audio/speech'
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                url,
                headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
                json={'model': model, 'input': text[:4096], 'voice': voice, 'response_format': 'mp3'},
            )
            if resp.status_code >= 400:
                return {
                    'ok': False,
                    'status': 502,
                    'error': f'TTS upstream {resp.status_code}: {resp.text[:300]}',
                }
            audio_b64 = base64.b64encode(resp.content).decode('ascii')
            return {
                'ok': True,
                'audio': audio_b64,
                'format': 'mp3',
                'model': model,
                'voice': voice,
                'provider': provider_id,
            }
    except httpx.RequestError as exc:
        return {'ok': False, 'status': 502, 'error': f'TTS request failed: {exc}'}
