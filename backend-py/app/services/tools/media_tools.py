"""Media analysis tools — the sanctioned way for the model to "see".

read_file refuses images/video/audio/documents (media guard in
file_tools.py); this module is where those files go instead:

* ``analyze_media``  — describe an image/video/audio/document. Images are
  sent to a vision-capable model through august's own provider stack
  (OpenAI-compatible ``image_url`` parts); video/audio get local ffprobe
  metadata plus frame extraction, and audio can be transcribed when STT
  is configured (live_speech pipeline).
* Everything is workspace-bound like every other tool; URLs pass through
  directly to the vision model.
"""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path

from app.services.sandbox.paths import bind_path

logger = logging.getLogger(__name__)

_IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
}


def _workspace() -> str:
    from app.services.workbench.context import currentSessionId
    from app.services.workbench.sessions import get_workbench_session

    sid = currentSessionId.get()
    if sid and sid != 'default':
        sess = get_workbench_session(sid)
        if sess is not None:
            return str(getattr(sess, 'workspacePath', '') or '')
    return ''


def _bind(path: str):
    bound, err = bind_path(path, _workspace(), for_write=False)
    if err or bound is None:
        raise ValueError(err or f'Invalid path: {path}')
    if not bound.exists():
        raise ValueError(f'File not found: {path}')
    return bound


# ── Local probes (no network) ─────────────────────────────────────────────


def _ffprobe(target: Path) -> dict[str, object] | None:
    """Media metadata via ffmpeg's ffprobe when available."""
    import shutil

    exe = shutil.which('ffprobe')
    if not exe:
        return None
    try:
        import subprocess as sp

        proc = sp.run(
            [exe, '-v', 'quiet', '-print_format', 'json',
             '-show_format', '-show_streams', str(target)],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            return None
        data = json.loads(proc.stdout)
        fmt = data.get('format') or {}
        streams = data.get('streams') or []
        out: dict[str, object] = {
            'durationSec': float(fmt.get('duration', 0) or 0),
            'sizeBytes': int(fmt.get('size', 0) or 0),
            'format': fmt.get('format_name'),
        }
        for s in streams:
            if s.get('codec_type') == 'video' and 'width' in s:
                out['video'] = {
                    'codec': s.get('codec_name'), 'width': s.get('width'),
                    'height': s.get('height'), 'fps': s.get('r_frame_rate'),
                }
            elif s.get('codec_type') == 'audio':
                out['audio'] = {
                    'codec': s.get('codec_name'), 'sampleRate': s.get('sample_rate'),
                    'channels': s.get('channels'),
                }
        return out
    except Exception as exc:
        logger.debug('ffprobe failed', exc_info=exc)
        return None


def _extract_video_frame(target: Path, tmpdir: Path) -> Path | None:
    """Grab a representative mid-video frame via ffmpeg (for vision)."""
    import shutil

    exe = shutil.which('ffmpeg')
    if not exe:
        return None
    try:
        import subprocess as sp

        frame = tmpdir / f'{target.stem}_frame.jpg'
        sp.run(
            [exe, '-v', 'error', '-i', str(target), '-vf',
             "select=eq(n\\,0)+gte(t\\,-1)", '-frames:v', '1', '-q:v', '3',
             str(frame)],
            capture_output=True, text=True, timeout=60,
        )
        return frame if frame.exists() and frame.stat().st_size > 0 else None
    except Exception as exc:
        logger.debug('frame extraction failed', exc_info=exc)
        return None


# ── Vision through august's own provider stack ────────────────────────────


async def _vision_describe(image_path: Path | str, question: str, url: str = '') -> str:
    """Ask a vision-capable model to describe an image.

    Uses the session's chat model/provider by default (same resolution as
    BTW), sending an OpenAI-style image_url part. Works with any provider
    whose gateway accepts multimodal chat input.
    """
    from app.providers.clients import getClient
    from app.services.workbench.context import currentSessionId
    from app.services.workbench.providers import resolve_chat_llm
    from app.services.workbench.sessions import get_workbench_session

    sid = currentSessionId.get() or ''
    session = get_workbench_session(sid) if sid else None
    provider, model = resolve_chat_llm(
        session_provider=str(getattr(session, 'provider', '') or ''),
        session_model=str(getattr(session, 'model', '') or ''),
    )
    if not provider or not model:
        return (
            'No provider/model configured for vision analysis. Set a chat '
            'model first (the analyzer reuses it), then retry.'
        )

    if url:
        image_part: dict[str, object] = {'type': 'image_url', 'image_url': {'url': url}}
    else:
        raw = Path(image_path).read_bytes()
        ext = Path(image_path).suffix.lower()
        media_type = _MIME.get(ext, 'image/png')
        b64 = base64.b64encode(raw).decode('ascii')
        image_part = {
            'type': 'image_url',
            'image_url': {'url': f'data:{media_type};base64,{b64}'},
        }

    client = getClient(provider)
    if client is None:
        return '(no provider client available for vision analysis)'
    body: dict[str, object] = {
        'model': model,
        'max_tokens': 1024,
        'messages': [
            {
                'role': 'user',
                'content': [
                    image_part,
                    {
                        'type': 'text',
                        'text': question
                        or 'Describe this image in detail: layout, labels, values, anything readable.',
                    },
                ],
            }
        ],
    }
    response = await client.chat_completions(body, apiKey=None)
    if response is None:
        return '(vision provider returned no response)'
    # ProviderResponse shape: content blocks or text.
    text_parts: list[str] = []
    for block in getattr(response, 'content', None) or []:
        if isinstance(block, dict) and block.get('type') == 'text':
            text_parts.append(str(block.get('text', '')))
    if not text_parts:
        fallback_text = getattr(response, 'text', None)
        if fallback_text:
            text_parts.append(str(fallback_text))
    return '\n'.join(text_parts) or '(empty vision response)'


async def analyze_media(
    path_or_url: str,
    question: str = '',
    workspace: str = '',
) -> dict[str, object]:
    """Analyze an image / video / audio / document file or URL.

    Returns a structured description: images → full vision description;
    video → ffprobe metadata + extracted-frame vision pass; audio → probe
    + transcription hook; documents → guidance toward parsers.
    """
    target = (path_or_url or '').strip()
    if not target:
        raise ValueError('path_or_url is required (workspace path or http(s) URL).')

    result: dict[str, object] = {'source': target}

    if target.startswith(('http://', 'https://')):
        if any(tok in target.lower() for tok in ('.mp4', '.webm', '.mov', '.mkv')):
            result['kind'] = 'video-url'
            result['note'] = 'Remote video: download with run_command (curl) first, then analyze locally.'
        else:
            desc = await _vision_describe('', question, url=target)
            result.update({'kind': 'image-url', 'description': desc})
        return result

    bound = _bind(target)
    ext = bound.suffix.lower()

    if ext in _IMAGE_EXTS:
        result['kind'] = 'image'
        result['description'] = await _vision_describe(bound, question)
        return result

    if ext == '.svg':
        result['kind'] = 'vector-image'
        svg_text = bound.read_text(encoding='utf-8', errors='replace')[:4000]
        result['structure'] = svg_text
        result['note'] = 'SVG source returned (it IS text) — shapes/labels above.'
        return result

    notes: list[str] = []
    if ext in ('.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.m4v'):
        result['kind'] = 'video'
        probe = _ffprobe(bound)
        if probe:
            result['metadata'] = probe
        import tempfile

        with tempfile.TemporaryDirectory(prefix='aug_media_') as td:
            frame = _extract_video_frame(bound, Path(td))
            if frame:
                try:
                    result['firstFrameDescription'] = await _vision_describe(frame, question)
                except Exception as exc:
                    result['firstFrameError'] = str(exc)[:200]
            else:
                notes.append('ffmpeg not found — install it for frame analysis.')
        if notes:
            result['note'] = ' '.join(notes)
        return result

    if ext in ('.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a', '.aac'):
        result['kind'] = 'audio'
        probe = _ffprobe(bound)
        if probe:
            result['metadata'] = probe
        # Transcription path: the live-speech STT endpoint accepts base64
        # audio (POST /api/live/stt) — hand back a ready-to-use hint.
        raw_len = bound.stat().st_size
        result['transcriptionPath'] = (
            f'POST /api/live/stt with audio_base64 (file is {raw_len} bytes; '
            'endpoint transcribes via the configured STT backend)'
        )
        return result

    if ext == '.pdf':
        result['kind'] = 'pdf-document'
        result['note'] = (
            'PDFs need their text layer extracted: use run_command with '
            'python (pypdf/pdfplumber) or pdftotext. Scanned PDFs should go '
            'page-by-page through this tool as images after rendering '
            '(pdftoppm).'
        )
        probe = _ffprobe(bound)
        if probe:
            result['metadata'] = probe
        return result

    if ext in ('.docx', '.xlsx', '.pptx', '.epub'):
        result['kind'] = 'office-document'
        result['note'] = (
            f'{ext} files are zip archives of XML — extract with run_command '
            '(python zipfile / python-pptx / openpyxl) rather than asking '
            'for a visual description.'
        )
        return result

    raise ValueError(
        f'Unsupported media type "{ext}". analyze_media covers images, '
        'video, audio, PDFs and office documents.'
    )
