"""Hermes-style size-driven compression for ``web_fetch`` page bodies.

| Page size (chars) | Behavior |
| ----------------- | -------- |
| Under raw max     | Return as-is |
| Up to compress max| Single-pass aux summary (cerebellum / hippocampus) |
| Above hard max    | Refuse with hint |
| Summarize fails   | Fallback to first raw-max chars |
"""

from __future__ import annotations

import asyncio
import logging

from app.json_narrowing import as_bool, as_int
from app.services.web_config_service import get_web_config

logger = logging.getLogger(__name__)

_SUMMARIZE_SYSTEM = (
    'You compress webpage content for an agent. Keep quotes, code blocks, numbers, '
    'names, and key facts in their original wording when possible. Do not invent facts. '
    'Output Markdown only — no preamble.'
)


async def _aux_summarize(text: str, *, max_out: int, timeout_s: float = 45.0) -> str:
    """Call a cheap fleet model; return '' on any failure."""

    async def _call() -> str:
        try:
            from app.providers import resolver as provider_resolver
            from app.providers.clients import getClient
            from app.services.workbench import model_fleet

            model = model_fleet.getModelForRole('cerebellum') or model_fleet.getModelForRole(
                'hippocampus'
            )
            if not model:
                return ''
            provider = provider_resolver.resolve(model)
            if not provider:
                available = [p for p in provider_resolver.list_available() if p.get('api_key')]
                provider = available[0] if available else None
            if not provider:
                return ''
            client = getClient(provider)
            if not client or not hasattr(client, 'generate'):
                return ''
            try:
                client.config = {**dict(client.config or {}), 'model': model}
            except Exception:
                pass
            prompt = (
                f'Summarize the following webpage content to at most ~{max_out} characters.\n\n'
                f'{text[:400_000]}'
            )
            raw = await client.generate(prompt, system=_SUMMARIZE_SYSTEM)
            return (raw or '').strip()[:max_out]
        except Exception:
            logger.debug('web_extract aux summarize failed', exc_info=True)
            return ''

    try:
        return await asyncio.wait_for(_call(), timeout=timeout_s)
    except asyncio.TimeoutError:
        logger.debug('web_extract aux summarize timed out after %.0fs', timeout_s)
        return ''


async def maybe_compress_page(url: str, body: str) -> tuple[str, dict[str, object]]:
    """Return ``(body, meta)`` where meta describes compression decisions."""
    cfg = get_web_config()
    raw_max = max(500, as_int(cfg.get('extractRawMaxChars'), 5000))
    summary_max = max(500, as_int(cfg.get('extractSummaryMaxChars'), 5000))
    compress_max = max(raw_max, as_int(cfg.get('extractCompressMaxChars'), 500_000))
    hard_max = max(compress_max, as_int(cfg.get('extractHardMaxChars'), 2_000_000))
    enabled = as_bool(cfg.get('extractCompress'), True)

    meta: dict[str, object] = {
        'url': url,
        'original_chars': len(body),
        'compressed': False,
        'mode': 'raw',
    }

    if not enabled:
        if len(body) > summary_max * 10:
            truncated = body[: summary_max * 10]
            meta['mode'] = 'truncated'
            meta['message'] = 'extractCompress disabled; truncated long page'
            return truncated, meta
        return body, meta

    if len(body) <= raw_max:
        return body, meta

    if len(body) > hard_max:
        meta['mode'] = 'refused'
        meta['message'] = (
            f'Page too large ({len(body)} chars > {hard_max}). '
            'Use a more focused URL or browser_get_content.'
        )
        return (
            f'URL: {url}\nError: {meta["message"]}',
            meta,
        )

    source = body if len(body) <= compress_max else body[:compress_max]
    if len(body) > compress_max:
        meta['truncated_before_summary'] = True

    summary = await _aux_summarize(source, max_out=summary_max)
    if summary:
        meta['compressed'] = True
        meta['mode'] = 'summarized'
        meta['summary_chars'] = len(summary)
        header = (
            f'URL: {url}\n'
            f'[summarized from {len(body)} chars → {len(summary)} chars]\n\n'
        )
        # Avoid double URL: header already includes URL; strip leading URL line from body path
        return header + summary, meta

    # Fallback: first raw_max chars (Hermes behavior)
    meta['mode'] = 'truncated_fallback'
    meta['message'] = 'Summarization unavailable; returning start of page'
    return body[:raw_max] + '\n…(truncated; summarization unavailable)', meta


def strip_fetch_envelope(content: str) -> tuple[str, str]:
    """Split ``URL:…\\nStatus:…\\n\\nbody`` into (header_prefix, body)."""
    if not content.startswith('URL:'):
        return '', content
    parts = content.split('\n\n', 1)
    if len(parts) == 1:
        return content, ''
    return parts[0] + '\n\n', parts[1]
