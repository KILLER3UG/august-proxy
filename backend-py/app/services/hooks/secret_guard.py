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
# The door is the TRANSPORT (`providers/clients/base.py` calls `wireBody` at its
# two httpx sends), not the body serializers. A first version wired the dump
# functions and a review round proved that covered neither real path: the
# workbench dumps an empty request and assigns `body['messages']` afterwards, and
# the proxy round-2 re-send appends tool results after the dump. The transport
# sees every body those paths send, and nothing else reaches a provider.
#
# Matched by VALUE, never by pattern, and only for credentials this app holds.
# A pattern scrub here would rewrite anything key-shaped: a user pasting their own
# `sk-…` to ask why it returns 401 would get advice about a string the model can
# no longer see. The false-positive cost is therefore the whole product.
_OUTBOUND_MIN_LEN = 12
# Credential-shaped env vars. Deliberately only `*_API_KEY`: including
# `_PASSWORD` / `_SECRET` / `_TOKEN` would rewrite a database password or an API
# token the user PASTED ON PURPOSE (write this into my .env, why does this
# PASSWORD fail) out from under them on every later turn. Those are secrets the
# user is working WITH; a provider key is a secret the install works FROM.
_OUTBOUND_ENV_SUFFIXES = ('_API_KEY',)
_outboundCache: list[tuple[str, str]] | None = None
_outboundStamp: tuple[object, ...] | None = None
_outboundWired = False


def _storeStamp() -> tuple[object, ...]:
    """(mtime_ns, size) of EVERY file a credential can be written to.

    providers.json holds the per-provider configuration and fires the
    invalidation callback on save; the gateway key does not — `routers/config.py`
    mints it through `saveConfig`, which busts neither the callback nor a
    providers.json stamp. Without config.json in the stamp, a rotated gateway
    key would be shipped forever and the retired one rewritten forever, which
    is the exact staleness this cache has to avoid.

    secrets.json is in the stamp for the same reason and one more: the
    service-connection tokens live there now (they used to live in
    config.json), and a token that was rotated must stop being scrubbed out
    of the body the moment it is retired — and a token that was ADDED must
    start being scrubbed at once.

    A file that is not there yet contributes (-1, -1) rather than failing the
    whole stamp: a fresh install has no store yet, and a stamp that cannot be
    taken would freeze the credential set for the life of the process (and
    turn every outbound body into a full re-read of every store).

    The stat is taken once per body, never per leaf (see `scrubOutboundBody`).
    """
    from app.lib.paths import dataPath

    stamps: list[object] = []
    for name in ('providers.json', 'config.json', 'secrets.json'):
        try:
            stat = dataPath(name).stat()
            stamps.extend((int(stat.st_mtime_ns), int(stat.st_size)))
        except OSError:
            stamps.extend((-1, -1))
    return tuple(stamps)


def _outboundLabel(name: str, value: str = '') -> str:
    clean = re.sub(r'[^A-Za-z0-9]+', '_', str(name or '')).strip('_').upper()
    if value and len(value) >= _OUTBOUND_MIN_LEN and value in (name or ''):
        # A provider NAMED after its own key would have the key echoed inside the
        # marker this substitution exists to put in its place.
        clean = re.sub(re.escape(value), 'REDACTED', str(name), flags=re.IGNORECASE)
        clean = re.sub(r'[^A-Za-z0-9]+', '_', clean).strip('_').upper()
    return f'[secret:{clean[:48] or "CREDENTIAL"}]'


def _collectOutboundSecrets() -> list[tuple[str, str]]:
    """(value, marker) for every credential this install holds.

    Sources: the providers store (where Settings writes every configured key),
    the ENCRYPTED STORE — which is where the service-connection tokens and the
    provider keys live now — the gateway key, and environment variables NAMED
    like credentials. The last is a name heuristic, not a registry, because a
    dev install exports keys the store never sees; a key held only in a
    keyring is out of reach here.

    The store is read AFTER the providers, so a provider key that is in both
    is labelled with the provider it belongs to — a marker the user can act
    on — rather than with a store key.

    Longest first: replacing a short value before a longer one that contains it
    would leave the longer secret's remainder on the wire.
    """
    found: dict[str, str] = {}

    def add(value: object, name: object) -> None:
        text = as_str(value, '').strip()
        if len(text) >= _OUTBOUND_MIN_LEN:
            found.setdefault(text, _outboundLabel(as_str(name, ''), text))

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
        from app.services import secret_store

        # Every value the store holds is a credential this install works FROM,
        # so every one of them belongs in the collection set. A token pasted
        # into a transcript used to ride out to whichever gateway was active
        # on every later turn, because this collector had never heard of the
        # service connections.
        for storeKey in secret_store.listSecretKeys():
            add(secret_store.getSecret(storeKey), storeKey)
    except Exception:  # noqa: BLE001 — fails open, but logged
        logger.warning('outbound scrub: secret store unreadable', exc_info=True)
    try:
        from app.config import settings

        add(getattr(settings, 'gatewayApiKey', None), 'gateway')
    except Exception:  # noqa: BLE001 — fails open, but logged
        logger.warning('outbound scrub: gateway key unreadable', exc_info=True)
    try:
        import os

        for name, value in os.environ.items():
            if name.endswith(_OUTBOUND_ENV_SUFFIXES):
                add(value, name)
    except Exception:  # noqa: BLE001 — fails open, but logged
        logger.warning('outbound scrub: environment unreadable', exc_info=True)
    return sorted(found.items(), key=lambda item: -len(item[0]))


def _outboundSecrets() -> list[tuple[str, str]]:
    """The credential set, rebuilt when the store changes.

    Two triggers, because neither alone is enough. The file stamp catches every
    writer (a hand-edit of providers.json or secrets.json, or
    `provider_credentials.invalidate()`, none of which fires the callback); the
    callback catches a key minted without touching the file (the gateway key is
    written through `saveConfig`, which busts neither). Registration is only
    marked done once it actually succeeded — setting the flag first meant one
    import hiccup disabled cache-busting for the life of the process.

    An EMPTY result is never cached: an unreadable store would otherwise turn
    the gate off permanently and silently, which is the blindness this whole
    round is about. Consumers take one local snapshot, so a rebuild on another
    thread cannot make a later read return an empty list mid-request.
    """
    global _outboundCache, _outboundStamp, _outboundWired
    stamp = _storeStamp()
    if _outboundCache is not None and stamp == _outboundStamp:
        return _outboundCache
    rebuilt = _collectOutboundSecrets()
    if rebuilt:
        _outboundCache = rebuilt
        _outboundStamp = stamp
        if not _outboundWired:
            try:
                from app.services import provider_credentials

                provider_credentials.registerInvalidationCallback(_invalidateOutbound)
                _outboundWired = True
            except Exception:  # noqa: BLE001 — the stamp still busts the cache
                logger.warning('outbound scrub: invalidation hook unavailable', exc_info=True)
    return rebuilt if _outboundCache is None else _outboundCache


def _invalidateOutbound() -> None:
    global _outboundCache, _outboundStamp
    _outboundCache = None
    _outboundStamp = None


def _scrubLeaf(text: str, secrets: list[tuple[str, str]]) -> str:
    out = text
    for value, marker in secrets:
        if value in out:
            out = out.replace(value, marker)
    return out


def _scrubWalk(value: object, secrets: list[tuple[str, str]]) -> object:
    if isinstance(value, str):
        return _scrubLeaf(value, secrets)
    if isinstance(value, dict):
        return {k: _scrubWalk(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrubWalk(v, secrets) for v in value]
    return value


def scrubOutboundText(text: str) -> str:
    """Replace this install's credential values with named markers."""
    return _scrubLeaf(text, _outboundSecrets())


def scrubOutboundBody(value: object) -> object:
    """Recursively scrub the string leaves of an outbound request body.

    Keys, structure and non-string values are rebuilt untouched — this runs on
    the path every provider request takes, so a body with no credential in it
    must come back byte-identical.

    The credential set is resolved ONCE per body, not per leaf: it is
    file-stamped, so a per-leaf read cost one `os.stat` per string in the
    transcript — measured at 204 ms and 1,307 stats on a 200 KB body against
    2.0 ms for the `json.dumps` that follows it.

    Three limits, stated because a security gate that implies more than it does is
    worse than a narrower one:
    * a value that arrives already JSON-escaped (a `\\u0073k-…` blob produced by a
      gateway SDK, or base64 of the transcript) does not match a literal value;
    * the marker is text the model can quote into a file, so the write door blocks
      it (`PRE_TOOL_USE`) rather than this door;
    * a credential the app cannot read (an OS keyring) is out of reach.
    """
    secrets = _outboundSecrets()
    if not secrets:
        return value
    return _scrubWalk(value, secrets)


def register(reg: HookRegistry) -> None:
    """Register secret guard hooks."""
    reg.register('secret_guard_write', HookEvent.PRE_TOOL_USE, _pre_tool_guard, matcher=_WRITE_TOOLS, priority=10)
    reg.register('secret_guard_read', HookEvent.POST_TOOL_USE, _post_tool_redact, matcher=_READ_TOOLS, priority=10)
