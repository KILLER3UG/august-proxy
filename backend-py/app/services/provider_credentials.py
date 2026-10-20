"""Provider credentials — the single source of truth for provider API keys.

THE SPLIT
---------
A provider's API key is a CREDENTIAL; everything else about it (name, base
URL, model list, flags) is configuration. The credential lives in the
encrypted store (``app/services/secret_store.py`` — Windows DPAPI, in the
user's data directory), the configuration lives in
``<dataDir>/providers.json``.

``providers.json`` is refused BY NAME at every listing door, and that is the
right rule — but it stopped the AGENT from reading the file and did nothing
about the bytes on disk, which were plain. Moving the key into the store is
what actually closes that hole: the file keeps the provider's shape and the
key leaves it.

This module owns the split:

* ``loadStore()`` — the providers store as every reader sees it, with the
  credentials merged back in. The FILE is read fresh on every call (most
  callers mutate what they get back, and a shared object would let one of
  them poison the next), but the DECRYPTION is cached on the ``(mtime, size)``
  of the two files it can live in. A provider read is therefore not a DPAPI
  call: the cache is rebuilt when a file changes, not when a reader asks.
* ``saveStore()`` — writes the credentials through to the store FIRST and the
  file second, without them.

THE MIGRATION
-------------
A ``providers.json`` written before this change holds its keys in the clear.
The first read moves them into the store and rewrites the file without them
— a lazy, idempotent migration on the read path, the same idiom
``service_connections`` uses for the service-connection tokens.

A plaintext key in the FILE wins over one in the store: the file is where a
human's hand-edit lands, and after a migration it is the only place a
plaintext value can still be. A key in the store that has no provider
anymore is pruned on the next save.

A FAILURE IS NEVER A LOSS
-------------------------
If the store refuses the write (DPAPI refuses on Windows), the plaintext is
left exactly where it was: ``providers.json`` keeps the key and the provider
keeps working. A degraded store beats a provider that cannot authenticate.

THE FILE'S FIELD PRESENCE IS THE SIGNAL
---------------------------------------
A provider entry says one of three things about its credential:

* the field is ABSENT — the credential is the STORE's business (it is in the
  store, or there is none);
* the field is PRESENT and EMPTY — this provider has NO credential, and the
  stored one must be forgotten (this is what a cleared key looks like);
* the field is PRESENT with a value — a plaintext credential this process has
  not been able to move into the store yet. It is absorbed on the way
  through and the file is rewritten without it.

The first two are not the same thing, and the difference is the whole point:
ABSENT is also what a store that could not be read looks like. A save that
read that as "cleared" would DELETE a credential the user still has.
"""

from __future__ import annotations

import json
import logging
from typing import Callable, Optional

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_dict, as_list, as_str
from app.lib.paths import dataPath
from app.services import secret_store

logger = logging.getLogger(__name__)

#: The store-key prefix for a provider's credentials.
#:
#: Stable, greppable, and the prefix the pruning works on — the same
#: convention the service connections use (``serviceConnections.<service>.<field>``).
#: A KEY NAME, not a credential: the noqa is for the band's S105 heuristic,
#: which reads the word "secret" in an identifier as a hardcoded password.
SECRET_PREFIX = 'providerCredentials.'  # noqa: S105

#: The suffix of the store key that holds a quota endpoint's own token.
#:
#: ``quotaAuth.token`` is a credential on the same footing as the chat key
#: (see ``routers/providers.py``), so it is stored the same way: under the
#: provider's own key, one level down. Also a key name — see SECRET_PREFIX.
QUOTA_TOKEN_SUFFIX = '.quotaToken'  # noqa: S105

#: The field of a quota declaration that holds the token. A field NAME.
QUOTA_TOKEN_FIELD = 'token'  # noqa: S105

# The decrypted credentials, keyed by store key, and the file stamp they
# were read at. The stamp is the (mtime_ns, size) of BOTH files a credential
# can live in — `providers.json` (the configuration) and `secrets.json` (the
# store) — because a change to either one changes what a provider resolves
# to, and a stale key is a provider that cannot authenticate.
_credentialCache: Optional[dict[str, str]] = None
_credentialStamp: Optional[tuple[object, ...]] = None

_invalidationCallbacks: list[Callable[[], None]] = []


def registerInvalidationCallback(callback: Callable[[], None]) -> Callable[[], None]:
    _invalidationCallbacks.append(callback)
    return callback


def _fireInvalidation() -> None:
    global _credentialCache, _credentialStamp
    # The store just changed, so anything cached from it is stale — including
    # the decrypted credentials, which are read from the same file.
    _credentialCache = None
    _credentialStamp = None
    for cb in _invalidationCallbacks:
        try:
            cb()
        except Exception:
            pass


def invalidate() -> None:
    """Drop the cached credentials and the pooled clients."""
    global _credentialCache, _credentialStamp
    _credentialCache = None
    _credentialStamp = None
    try:
        from app.providers.clients import clear_client_pool

        clear_client_pool()
    except Exception:
        pass


# ── the providers file ─────────────────────────────────────────────────────


def _providersPath():
    return dataPath('providers.json')


def _readProvidersFile() -> dict[str, object]:
    """``providers.json`` as it is on disk. Missing or unreadable is an empty store."""
    try:
        raw = _providersPath().read_text('utf-8')
    except OSError:
        return {}
    try:
        return as_dict(json.loads(raw))
    except json.JSONDecodeError:
        logger.error('providers store at %s is not valid JSON — treating it as empty', _providersPath())
        return {}


def _writeProvidersFile(data: dict[str, object]) -> None:
    path = _providersPath()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, data, indent=2)


def _credentialStampNow() -> tuple[object, ...]:
    """``(mtime_ns, size)`` of the two files a provider credential can live in.

    A missing file contributes ``(-1, -1)`` rather than failing the whole
    stamp: a fresh install has no store yet, and a stamp that cannot be taken
    would turn every provider read into a fresh decryption.
    """
    stamps: list[object] = []
    for name in ('providers.json', 'secrets.json'):
        try:
            stat = dataPath(name).stat()
            stamps.extend((int(stat.st_mtime_ns), int(stat.st_size)))
        except OSError:
            stamps.extend((-1, -1))
    return tuple(stamps)


# ── the store keys ─────────────────────────────────────────────────────────


def _credentialKey(entry: dict[str, object], index: int) -> str:
    """The store key for one provider's credentials.

    The provider's id is stable — the UI mints ``<slug>-<random>`` and never
    changes it — so it is the key. A provider without an id falls back to its
    name, and one without either to its position: the last is a fallback for a
    malformed entry, not a plan.
    """
    providerId = as_str(entry.get('id')).strip()
    if providerId:
        return f'{SECRET_PREFIX}{providerId}'
    name = as_str(entry.get('name')).strip()
    if name:
        return f'{SECRET_PREFIX}name.{name}'
    return f'{SECRET_PREFIX}index.{index}'


def _quotaTokenKey(key: str) -> str:
    return f'{key}{QUOTA_TOKEN_SUFFIX}'


def _withoutCredentials(data: dict[str, object]) -> dict[str, object]:
    """A copy of the providers store with every credential removed.

    A copy, not an in-place edit: the caller keeps its own dict — the routers
    read ``apiKeySet``/``apiKeyMasked`` off it AFTER the save — and must not
    find it emptied.

    A credential field that is PRESENT and EMPTY is kept: that is the
    "this provider has no credential" marker (see the module docstring). A
    field that carries a value is dropped, because the value now lives in the
    store.
    """
    out = dict(data)
    if 'providers' not in data:
        return out
    providers: list[object] = []
    for entry in as_list(data.get('providers'), []):
        if not isinstance(entry, dict):
            providers.append(entry)
            continue
        copied = dict(entry)
        if as_str(copied.get('apiKey')):
            copied.pop('apiKey', None)
        quota = copied.get('quotaAuth')
        if isinstance(quota, dict):
            quota = dict(quota)
            if as_str(quota.get(QUOTA_TOKEN_FIELD)):
                quota.pop(QUOTA_TOKEN_FIELD, None)
            copied['quotaAuth'] = quota
        providers.append(copied)
    out['providers'] = providers
    return out


# ── read / write ───────────────────────────────────────────────────────────


def _syncCredentials(data: dict[str, object]) -> dict[str, str]:
    """The decrypted credentials, keyed by store key.

    Cached on the ``(mtime, size)`` of ``providers.json`` and
    ``secrets.json``: a provider read must not be a DPAPI call, and a change
    to either file must be seen at once.

    A key found in the FILE is one this process has not been able to move
    into the store yet — a store that did not exist, a failed migration, a
    hand-edit. It is moved now, and the file is rewritten without it. The
    file wins over the store, because after a migration the file is the only
    place a plaintext value can still be.
    """
    global _credentialCache, _credentialStamp

    stamp = _credentialStampNow()
    if _credentialCache is not None and stamp == _credentialStamp:
        return _credentialCache

    entries = as_list(data.get('providers'), [])
    pending: dict[str, str] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        key = _credentialKey(entry, index)
        apiKey = as_str(entry.get('apiKey'))
        if apiKey:
            pending[key] = apiKey
        quota = as_dict(entry.get('quotaAuth'))
        token = as_str(quota.get(QUOTA_TOKEN_FIELD))
        if token:
            pending[_quotaTokenKey(key)] = token

    if pending:
        try:
            secret_store.setSecrets(pending)
            _writeProvidersFile(_withoutCredentials(data))
            logger.info('moved %d provider credential(s) into the encrypted store', len(pending))
        except Exception as exc:  # noqa: BLE001 — the fail-safe below is the point
            # The plaintext stays exactly where it is: the provider keeps
            # working, and the next read tries the move again.
            logger.error(
                'provider credential migration failed; the keys stay in providers.json: %s', exc
            )

    keys: dict[str, str] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        key = _credentialKey(entry, index)
        for storeKey in (key, _quotaTokenKey(key)):
            value = secret_store.getSecret(storeKey)
            if value:
                keys[storeKey] = value
    _credentialCache = keys
    # Re-stamped AFTER the writes above, so the cache is not stale against
    # the files it was just built from.
    _credentialStamp = _credentialStampNow()
    return keys


def _mergeCredentials(data: dict[str, object], keys: dict[str, str]) -> None:
    """Put the decrypted credentials back into the store view.

    The FILE's value wins over the store's: after a migration the file is the
    only place a plaintext value can still be, and a hand-edit of
    ``providers.json`` is the user's business.

    A credential field that is PRESENT and EMPTY is left alone — it says
    "this provider has no credential", and the store must not quietly put one
    back. A field that is ABSENT means "the credential is the store's
    business", which is also what a store that could not be read looks like;
    the difference is why the two are not the same thing.
    """
    entries = as_list(data.get('providers'), [])
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        key = _credentialKey(entry, index)
        apiKey = as_str(entry.get('apiKey')) or keys.get(key)
        if apiKey:
            entry['apiKey'] = apiKey
        quota = as_dict(entry.get('quotaAuth'))
        if quota:
            token = as_str(quota.get(QUOTA_TOKEN_FIELD)) or keys.get(_quotaTokenKey(key))
            if token:
                quota[QUOTA_TOKEN_FIELD] = token


def loadStore() -> dict[str, object]:
    """The providers store, with the credentials merged back in.

    The file is read fresh on every call — a caller that mutates the result
    (most of them do) must not poison what the next caller sees. The
    DECRYPTION is cached, so this is not a DPAPI call per read.
    """
    data = _readProvidersFile()
    keys = _syncCredentials(data)
    _mergeCredentials(data, keys)
    return data


def saveStore(data: dict[str, object]) -> None:
    """Persist the providers store, with the credentials in the encrypted store.

    The store is written FIRST. If it refuses — DPAPI refuses on Windows —
    the credentials stay in ``providers.json``: degraded, but working. A
    provider that cannot authenticate is worse than a plaintext key.
    """
    global _credentialCache, _credentialStamp

    entries = as_list(data.get('providers'), [])
    toStore: dict[str, str] = {}
    live: set[str] = set()
    cleared: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        key = _credentialKey(entry, index)
        live.add(key)
        if 'apiKey' in entry:
            value = as_str(entry.get('apiKey'))
            if value:
                toStore[key] = value
            else:
                # Present and EMPTY: the caller says this provider has no
                # credential, so the stored one must go.
                cleared.add(key)
        quota = as_dict(entry.get('quotaAuth'))
        if quota:
            live.add(_quotaTokenKey(key))
            if QUOTA_TOKEN_FIELD in quota:
                token = as_str(quota.get(QUOTA_TOKEN_FIELD))
                if token:
                    toStore[_quotaTokenKey(key)] = token
                else:
                    cleared.add(_quotaTokenKey(key))
    # A slot that is live but carries no value is the STORE's business: the
    # provider exists and its credential was never cleared, so the stored
    # value must survive — including when the store could not be read during
    # the load that produced this view. Pruning it would DELETE a credential
    # the user still has.
    keep = (live | set(toStore)) - cleared

    stored = True
    try:
        # Prune FIRST: a credential whose provider no longer exists must not
        # outlive it. Pruning before the write means a failed write leaves
        # the file's own plaintext to be re-absorbed on the next read.
        secret_store.pruneSecrets(SECRET_PREFIX, keep=keep)
        secret_store.setSecrets(toStore)
    except Exception as exc:  # noqa: BLE001 — the fail-safe below is the point
        logger.error(
            'provider credentials could not be stored; they stay in providers.json: %s', exc
        )
        stored = False

    if stored:
        _writeProvidersFile(_withoutCredentials(data))
    else:
        _writeProvidersFile(data)
    _credentialCache = None
    _credentialStamp = None


# ── resolution ─────────────────────────────────────────────────────────────


def _customEntry(store: dict[str, object], nameOrId: str) -> Optional[dict[str, object]]:
    target = nameOrId.lower()
    id_match: Optional[dict[str, object]] = None
    name_match: Optional[dict[str, object]] = None
    for entry in as_list(store.get('providers'), []):
        if isinstance(entry, dict):
            if as_str(entry.get('id'), '').lower() == target and id_match is None:
                id_match = entry
            if as_str(entry.get('name'), '').lower() == target and name_match is None:
                name_match = entry
    return id_match or name_match


def _customProviderDict(entry: dict[str, object]) -> dict[str, object]:
    from app.providers.resolver import entry_to_provider_dict

    return entry_to_provider_dict(entry)


def resolve(nameOrId: str) -> Optional[dict[str, object]]:
    """Return ``{provider, api_key, baseUrl, apiMode, source}`` or ``None``."""
    if not nameOrId:
        return None
    custom = _customEntry(loadStore(), nameOrId)
    if custom and custom.get('enabled') and custom.get('apiKey'):
        api_key: Optional[str] = as_str(custom.get('apiKey'), '')
        return {
            'provider': _customProviderDict(custom),
            'api_key': api_key,
            'baseUrl': as_str(custom.get('baseUrl'), ''),
            'apiMode': as_str(custom.get('apiFormat'), 'openaiChat'),
            'source': 'custom_store',
        }
    from app.providers import resolver as provider_resolver
    from app.providers.clients import getClient

    provider = provider_resolver.resolve(nameOrId)
    if not provider:
        return None
    api_key = as_str(provider.get('api_key') or provider.get('apiKey'))
    if not api_key:
        client = getClient(provider)
        if client:
            api_key = client.resolveApiKey() or ''
    if not api_key:
        return None
    return {
        'provider': provider,
        'api_key': api_key,
        'baseUrl': as_str(provider.get('baseUrl'), ''),
        'apiMode': as_str(provider.get('apiMode'), 'openaiChat'),
        'source': 'providers_store',
    }
