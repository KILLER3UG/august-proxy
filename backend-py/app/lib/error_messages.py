"""Actionable error messages — map provider errors to user-friendly guidance.

Part of Better Harness Plan Phase 4.3.
"""

from __future__ import annotations

import re


def map_provider_error(
    status_code: int,
    provider_name: str,
    model: str | None = None,
    detail: str = '',
    api_format: str | None = None,
) -> dict:
    """Map a provider HTTP error to an actionable user message.

    Returns: {code, message, action: {type, ...}, severity}
    """
    if status_code == 401:
        return {
            'code': 401,
            'message': f'API key rejected for {provider_name}. Check your key in Settings → Providers.',
            'action': {'type': 'settings_link', 'section': 'providers'},
            'severity': 'error',
        }

    if status_code == 403:
        return {
            'code': 403,
            'message': f'Access denied by {provider_name}. Your key may lack permission for this model or endpoint.',
            'action': {'type': 'settings_link', 'section': 'providers'},
            'severity': 'error',
        }

    if status_code == 429:
        retry_after = _extract_retry_after(detail)
        msg = f'Rate limited by {provider_name}.'
        if retry_after:
            msg += f' Retrying in {retry_after}s.'
        return {
            'code': 429,
            'message': msg,
            'action': {'type': 'retry', 'delayS': retry_after or 30},
            'severity': 'warning',
        }

    if status_code == 404:
        if model:
            return {
                'code': 404,
                'message': f'Model "{model}" not found on {provider_name}'
                + (f"'s {api_format} endpoint." if api_format else '.'),
                'action': {'type': 'switch_format', 'provider': provider_name},
                'severity': 'error',
            }
        return {
            'code': 404,
            'message': f'Endpoint not found on {provider_name}. Check the base URL.',
            'action': {'type': 'settings_link', 'section': 'providers'},
            'severity': 'error',
        }

    if status_code == 400:
        # Pattern-match known 400 errors
        if 'session_id' in detail.lower() and 'null' in detail.lower():
            return {
                'code': 400,
                'message': f'{provider_name} rejected the request (null session_id). Null fields will be stripped — try updating.',
                'action': {'type': 'none'},
                'severity': 'error',
            }
        if 'context_length' in detail.lower() or 'token' in detail.lower():
            return {
                'code': 400,
                'message': f'Context too long for {model or "this model"} on {provider_name}. Try a shorter conversation or larger-context model.',
                'action': {'type': 'none'},
                'severity': 'warning',
            }
        return {
            'code': 400,
            'message': f'{provider_name} rejected the request: {detail[:150]}',
            'action': {'type': 'none'},
            'severity': 'error',
        }

    if status_code >= 500:
        return {
            'code': status_code,
            'message': f'{provider_name} server error ({status_code}). The provider may be experiencing issues.',
            'action': {'type': 'retry', 'delayS': 10},
            'severity': 'warning',
        }

    # Timeout (no status code)
    if status_code == 0:
        return {
            'code': 0,
            'message': f'Connection to {provider_name} timed out. Check your network or base URL.',
            'action': {'type': 'check_network'},
            'severity': 'error',
        }

    return {
        'code': status_code,
        'message': f'{provider_name} returned HTTP {status_code}: {detail[:150]}',
        'action': {'type': 'none'},
        'severity': 'error',
    }


def _extract_retry_after(detail: str) -> int | None:
    """Try to extract a retry-after delay from error detail."""
    match = re.search(r'(\d+)\s*(?:seconds?|s\b)', detail, re.I)
    if match:
        return int(match.group(1))
    return None
