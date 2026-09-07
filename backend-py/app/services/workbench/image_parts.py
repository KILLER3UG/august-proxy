"""Inline composer image attachments into the chat wire (Hermes-style turns).

Composer images are persisted by ``POST /api/workbench/attachments`` to
``<workspace>/.aug/attachments/<sessionId>/<name>`` and the user message text
names the path (``[Attached file — stored at …]``). Until now that was ALL the
chat model ever got — seeing the image required a second, tool-mediated
``analyze_media`` round trip through a separate non-streaming vision client,
which fails differently from the chat request itself (rate gates, model
mismatches) and made every image chat look "blind".

``inline_image_parts`` upgrades those messages ON THE WIRE ONLY: user messages
whose text names an image attachment get multipart content with the image as
an Anthropic-style base64 block —
``{'type': 'image', 'source': {'type': 'base64', 'media_type', 'data'}}``.
Both wire translators already handle that shape: translateMessagesToAnthropic
passes user content through verbatim, and translateMessages (OpenAI/Responses
path) converts it to an ``image_url`` data URI. Session storage keeps the
plain string — persistence, BTW, compression and the UI never see list
content.

Parsing failures and missing files are skipped silently (the model still has
the path and can retry via analyze_media) — a broken attachment must never
fail the turn.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path

from app.json_narrowing import as_str

_IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
}
# Matches the exact receipt ChatAttachmentService composes for every upload:
# "[Attached file — stored at <path>. Open it with analyze_media (kind) or read_file.]"
_STORED_AT_RE = re.compile(r'\[Attached file — stored at (.+?)\. Open it with')

# Per-dispatch budget for inlined images (raw bytes before base64). History
# rides every turn, so an unbounded cap would let one image-heavy session
# inflate every future request.
_MAX_INLINE_BYTES = 16 * 1024 * 1024
# (mtime, size, block) per path — re-reads only when the file actually changed.
_cache: dict[str, tuple[float, int, dict[str, object]]] = {}
_CACHE_MAX = 64


def _loadImageBlock(path: str) -> tuple[dict[str, object], int] | None:
    """One image as an Anthropic-style base64 block, plus its raw byte size.

    Returns None for missing/unreadable/non-image files (never raises).
    """
    try:
        p = Path(path)
        if not p.is_file():
            return None
        st = p.stat()
        if st.st_size > _MAX_INLINE_BYTES:
            return None
        cached = _cache.get(path)
        if cached is not None and cached[0] == st.st_mtime and cached[1] == st.st_size:
            return cached[2], cached[1]
        media = _MIME.get(p.suffix.lower(), 'image/png')
        block: dict[str, object] = {
            'type': 'image',
            'source': {
                'type': 'base64',
                'media_type': media,
                'data': base64.b64encode(p.read_bytes()).decode('ascii'),
            },
        }
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()
        _cache[path] = (st.st_mtime, st.st_size, block)
        return block, st.st_size
    except Exception:
        return None


def inline_image_parts(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    """Upgrade user messages that reference stored image attachments to
    multipart content (text + image blocks). Returns the input list untouched
    when nothing matches — zero overhead for image-free chats."""
    out: list[dict[str, object]] | None = None
    budget = _MAX_INLINE_BYTES
    for i, msg in enumerate(messages):
        if as_str(msg.get('role'), '') != 'user' or not isinstance(msg.get('content'), str):
            continue
        text = as_str(msg.get('content'), '')
        if 'stored at' not in text:
            continue
        blocks: list[dict[str, object]] = []
        for m in _STORED_AT_RE.finditer(text):
            if budget <= 0:
                break
            path = m.group(1).strip()
            if Path(path).suffix.lower() not in _IMAGE_EXTS:
                continue
            loaded = _loadImageBlock(path)
            if loaded is None:
                continue
            block, size = loaded
            blocks.append(block)
            budget -= size
        if not blocks:
            continue
        if out is None:
            out = list(messages)
        out[i] = {**msg, 'content': [{'type': 'text', 'text': text}, *blocks]}
    return out if out is not None else messages
