"""Media analysis tool registration (vision_analyze equivalent).

The destination for everything read_file's media guard redirects away:
images, video, audio, PDFs and office documents. Read-only.
"""

from __future__ import annotations

import json

from app.services import tool_registry
from app.services.tools import media_tools


async def _analyzeMedia(pathOrUrl: str = '', question: str = '') -> str:
    try:
        result = await media_tools.analyze_media(pathOrUrl, question)
        return json.dumps(result)
    except Exception as exc:
        return f'Error: {exc}'


def register() -> None:
    """Register media analysis tools."""
    tool_registry.register(
        'analyze_media',
        'Analyze an image, video, audio file, or document — the ONLY way to '
        'see media content (read_file refuses binary files). Images are '
        'described by a vision model using the session provider; video '
        'returns ffprobe metadata + a frame description; audio returns '
        'duration/codec info with a transcription path; URLs work directly. '
        'Pass question to focus the analysis.',
        _analyzeMedia,
        {
            'type': 'object',
            'properties': {
                'pathOrUrl': {
                    'type': 'string',
                    'description': 'Workspace file path or http(s) URL',
                },
                'question': {'type': 'string', 'description': 'What to look for'},
            },
            'required': ['pathOrUrl'],
        },
    )
