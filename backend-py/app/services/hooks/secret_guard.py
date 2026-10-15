"""Secret guard hook — blocks credential exposure via tool calls.

PRE_TOOL_USE: scans write arguments for secret patterns → deny.
POST_TOOL_USE: redacts secrets from read results on protected paths.
"""

from __future__ import annotations

import logging
import re

from app.json_narrowing import as_dict, as_list, as_str
from app.services.hooks.registry import HookRegistry
from app.services.hooks.types import HookContext, HookEvent, HookResult

logger = logging.getLogger('august.hooks.secret_guard')

# Secret patterns (never log the matched value)
_SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ('OpenAI API key', re.compile(r'sk-[a-zA-Z0-9]{20,}')),
    ('Anthropic API key', re.compile(r'sk-ant-[a-zA-Z0-9\-]{20,}')),
    ('AWS access key', re.compile(r'AKIA[0-9A-Z]{16}')),
    ('GitHub token', re.compile(r'ghp_[a-zA-Z0-9]{36}')),
    ('GitLab token', re.compile(r'glpat-[a-zA-Z0-9\-]{20,}')),
    ('Slack token', re.compile(r'xox[bpras]-[a-zA-Z0-9\-]{10,}')),
    ('Private key', re.compile(r'-----BEGIN (?:RSA |EC )?PRIVATE KEY-----')),
    ('Generic secret assignment', re.compile(
        r'\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*[\'"][^\'"]{8,}[\'"]',
        re.IGNORECASE,
    )),
]

# Protected file paths (POST_TOOL_USE redaction)
_PROTECTED_PATH_PATTERNS = re.compile(
    r'(\.env|providers\.json|credentials|\.ssh/|id_rsa|\.aws/|\.npmrc|\.pypirc)',
    re.IGNORECASE,
)

_WRITE_TOOLS = (
    'write_file|write_files|edit_file|create_file|create_files|run_command|'
    'str_replace|str_replace_editor|apply_patch|patch_file|bulk'
)
_READ_TOOLS = 'read_file|read_files|list_directory|search_files|bulk'


def scan_secrets(text: str) -> list[str]:
    """Return labels of every secret pattern found in ``text`` (never the values)."""
    return [label for label, pattern in _SECRET_PATTERNS if pattern.search(text)]


def _scan_for_secrets(text: str) -> str | None:
    """Return the label of the first secret pattern found, or None."""
    found = scan_secrets(text)
    return found[0] if found else None


def _redact_secrets(text: str) -> str:
    """Replace secret values with [REDACTED]."""
    result = text
    for _label, pattern in _SECRET_PATTERNS:
        result = pattern.sub('[REDACTED]', result)
    return result


def _text_values(value: object):
    """Yield all string leaves, including nested bulk-tool file entries."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _text_values(nested)
    elif isinstance(value, (list, tuple)):
        for nested in value:
            yield from _text_values(nested)


async def _pre_tool_guard(ctx: HookContext) -> HookResult:
    """Block writes containing secret patterns."""
    if not ctx.tool_args:
        return HookResult(action='allow')

    found = None
    for text in _text_values(ctx.tool_args):
        found = _scan_for_secrets(text)
        if found:
            break
    if found:
        return HookResult(
            action='deny',
            message=f'Blocked: {found} pattern detected in {ctx.tool_name}. '
                    'Remove credentials before proceeding.',
        )
    return HookResult(action='allow')


async def _post_tool_redact(ctx: HookContext) -> HookResult:
    """Redact secrets from reads of protected paths."""
    # Canonicalize backslashes so Windows paths match the protected patterns.
    protected_path = any(
        _PROTECTED_PATH_PATTERNS.search(text.replace('\\', '/'))
        for text in _text_values(ctx.tool_args or {})
    )
    if not protected_path:
        return HookResult(action='allow')

    if ctx.tool_result:
        redacted = _redact_secrets(ctx.tool_result)
        if redacted != ctx.tool_result:
            return HookResult(action='modify', modified_result=redacted)
    return HookResult(action='allow')


# ── outbound scrub ───────────────────────────────────────────────────────────
# The two guards above police the TOOL boundary: a write that carries a secret is
# denied, and a read of a protected path is redacted. Neither covers the way a
# credential actually leaves: it rides into the transcript once (pasted by the
# user, quoted by a log line, printed by a command whose path looked harmless)
# and is then re-sent to whichever gateway is active on EVERY later turn.
# DeepSeek-Bot closes that at the request door in `secrets.js` — the value is
# replaced by `[secret:<NAME>]` on the wire, so the machine's own credential
# inventory never travels in a prompt body.
#
# Matched by VALUE, never by pattern, and only for credentials this app holds.
# A pattern scrub here would rewrite anything key-shaped: a user pasting their own
# `sk-…` to ask why it returns 401 would get advice about a string the model can
# no longer see. This is the one serialization path every chat request takes, so
# the false-positive cost is the whole product.
_OUTBOUND_MIN_LEN = 12
_outboundCache: list[tuple[str, str]] | None = None
_outboundWired = False


def _outboundLabel(name: str) -> str:
    clean = re.sub(r'[^A-Za-z0-9]+', '_', str(name or '')).strip('_').upper()
    return f'[secret:{clean[:48] or "CREDENTIAL"}]'


def _collectOutboundSecrets() -> list[tuple[str, str]]:
    """(value, marker) for every credential this install holds.

    Sources: the providers store (where Settings writes every configured key),
    the gateway key, and environment variables NAMED like credentials — the last
    is a name heuristic, not a registry, because a dev install exports keys the
    store never sees; a key held only in a keyring is out of reach here.

    Longest first: replacing a short value before a longer one that contains it
    would leave the longer secret's remainder on the wire.
    """
    found: dict[str, str] = {}

    def add(value: object, name: object) -> None:
        text = as_str(value, '').strip()
        if len(text) >= _OUTBOUND_MIN_LEN:
            found.setdefault(text, _outboundLabel(as_str(name, '')))

    try:
        from app.services import config_service

        store = as_dict(config_service.getProvidersStore())
        for entry in as_list(store.get('providers'), []):
            if isinstance(entry, dict):
                add(entry.get('apiKey') or entry.get('api_key'), entry.get('name') or entry.get('id'))
    except Exception:  # noqa: BLE001 — fails open, but logged
        # Fails OPEN on purpose — this runs on every chat request and must not
        # break a turn. But it logs: a scrub that silently read nothing is the
        # same class of blindness as the error envelope that swallowed a
        # provider's reason, and nobody would know the gate was off.
        logger.warning('outbound scrub: provider store unreadable', exc_info=True)
    try:
        from app.config import settings

        add(getattr(settings, 'gatewayApiKey', None), 'gateway')
    except Exception:  # noqa: BLE001 — fails open, but logged
        logger.warning('outbound scrub: gateway key unreadable', exc_info=True)
    try:
        import os

        for name, value in os.environ.items():
            if name.endswith(('_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD')):
                add(value, name)
    except Exception:  # noqa: BLE001 — fails open, but logged
        logger.warning('outbound scrub: environment unreadable', exc_info=True)
    return sorted(found.items(), key=lambda item: -len(item[0]))


def _outboundSecrets() -> list[tuple[str, str]]:
    """The cache, busted through the store's own invalidation hook.

    `saveProvidersStore` fires `provider_credentials._fireInvalidation`, so a key
    edited in Settings stops being shipped on the next request without a per
    request file read — the stamp-on-read pattern AGENTS.md records for the price
    index, but through the callback the store already offers.
    """
    global _outboundCache, _outboundWired
    if _outboundCache is None:
        _outboundCache = _collectOutboundSecrets()
        if not _outboundWired:
            _outboundWired = True
            try:
                from app.services import provider_credentials

                provider_credentials.registerInvalidationCallback(_invalidateOutbound)
            except Exception:  # noqa: BLE001 — the cache still rebuilds
                logger.warning('outbound scrub: invalidation hook unavailable', exc_info=True)
    return _outboundCache


def _invalidateOutbound() -> None:
    global _outboundCache
    _outboundCache = None


def scrubOutboundText(text: str) -> str:
    """Replace this install's credential values with named markers."""
    out = text
    for value, marker in _outboundSecrets():
        if value in out:
            out = out.replace(value, marker)
    return out


def scrubOutboundBody(value: object) -> object:
    """Recursively scrub the string leaves of an outbound request body.

    Keys, structure and non-string values are rebuilt untouched — this runs on
    the serialization path every chat request takes, so a body with no credential
    in it must come back byte-identical.
    """
    if not _outboundSecrets():
        return value
    if isinstance(value, str):
        return scrubOutboundText(value)
    if isinstance(value, dict):
        return {k: scrubOutboundBody(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrubOutboundBody(v) for v in value]
    return value


def register(reg: HookRegistry) -> None:
    """Register secret guard hooks."""
    reg.register('secret_guard_write', HookEvent.PRE_TOOL_USE, _pre_tool_guard, matcher=_WRITE_TOOLS, priority=10)
    reg.register('secret_guard_read', HookEvent.POST_TOOL_USE, _post_tool_redact, matcher=_READ_TOOLS, priority=10)
