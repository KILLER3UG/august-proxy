"""August's encrypted secret store — the at-rest home for service tokens.

WHERE IT LIVES, AND WHY NOT ``config.json``
--------------------------------------------
``<dataDir>/secrets.json`` — the user's data directory, beside
``providers.json``, and nowhere else.

``config.json`` is the user's SETTINGS file: the thing that gets copied,
synced, backed up and read as ordinary settings, and the file a model with
``write_file`` and Full access can name. It is also where the Google /
GitHub / Slack tokens were found in PLAINTEXT. A secret needs a home that is
(a) not a settings file, and (b) a file the agent cannot read or write. The
provider API keys already moved this way — into ``data/providers.json`` —
and this store is the same idea for the service connections.

THE FILE
--------
JSON, one file, one shape::

    {
      "version": 1,
      "mode": "dpapi-user",
      "updatedAt": "2026-10-20T06:21:33+00:00",
      "secrets": {
        "serviceConnections.google.refreshToken": {
          "enc": "dpapi-user",
          "blob": "<base64 of the CryptProtectData ciphertext>",
          "updatedAt": "2026-10-20T06:21:33+00:00"
        }
      }
    }

The per-entry ``enc`` field is authoritative — it says how THAT value is
protected, so a file written on one host and read on another still says the
truth. The file-level ``mode`` is the weakest protection present in the file,
so a reader can see at a glance that a value is not encrypted.

THE ENCRYPTION
--------------
Windows **DPAPI** (``CryptProtectData``), reached through ``ctypes`` — no
new dependency, because the Windows API is already there. The blob is
encrypted under the signed-in user's DPAPI master key, which lives in that
user's profile and is itself protected by their logon credentials. So a
blob is bound to BOTH the user and the machine: another Windows account on
the same box cannot read it, and a copy of the file on another machine
cannot either. See ``app/lib/dpapi.py`` for exactly what that does and does
not buy.

THE NON-WINDOWS HOST — A LABELLED PLAINTEXT FALLBACK, NOT A SILENT ONE
-----------------------------------------------------------------------
The backend also runs in Docker and under a bare uvicorn on Linux, where
there is no DPAPI. The choice made here is a **plaintext fallback that says
so, loudly and in the file itself**:

* the entry is written with ``"enc": "plaintext"`` and the value under a
  ``plaintext`` key — the file does not LOOK encrypted and does not claim
  to be;
* the file-level ``mode`` becomes ``"plaintext-fallback"`` and carries a
  ``warning`` string;
* a warning is logged.

The alternative — a hard failure — was rejected because it would take the
Google connection apart on every non-Windows deployment, and the Docker path
is a supported one. A labelled fallback degrades the protection and says so;
a silent one would be a lie told by a file. On WINDOWS there is no fallback
at all: if DPAPI refuses, the write fails and the caller's plaintext is left
where it was.

WHAT IS *NOT* IN HERE
---------------------
* ``~/.google_workspace_mcp/credentials/<account>.json`` — a SECOND plaintext
  copy of the same tokens, written for the external ``workspace-mcp`` process,
  which cannot decrypt DPAPI. It is not a store bug and this module cannot
  fix it: the file's format is the external tool's contract. See
  ``app/services/service_connections.py`` (``_write_workspace_mcp_credentials``)
  for what was done about it and what was not.
* ``providers.json`` — the provider API keys were in the clear there too,
  and are in this store now (``providerCredentials.<providerId>``). The FILE
  still holds the provider's name, baseUrl, models and flags, and a
  ``defaultHeaders`` map can still carry an ``Authorization: Bearer`` value
  in the clear: a credential-shaped MAP cannot be split without a new
  per-field convention.
* ``mcp-servers.json`` — a per-server ``env`` map can hold a token in the
  clear. A different file, with different consumers, not yet absorbed.

A NOTE ON LISTING
-----------------
This store is **unlistable**: it is a credential store, and AGENTS.md's rule
is that a credential store is unlistable. Nothing here is routed — there is
no endpoint, no tool and no listing helper that names a secret or its key.
``listSecretKeys`` exists for diagnostics inside the backend only.
"""

from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_dict, as_str
from app.lib import dpapi
from app.lib.paths import dataPath

logger = logging.getLogger(__name__)

#: The store file, in the user's data directory.
STORE_FILENAME = 'secrets.json'

#: Bumped only when the on-disk shape changes incompatibly.
STORE_VERSION = 1

#: How a value in the store is protected.
#:
#: ``MODE_DPAPI`` is BOTH the per-entry label and the file-level mode of a
#: store whose every value is DPAPI-protected. ``ENTRY_PLAINTEXT`` labels ONE
#: value that is not encrypted; ``MODE_PLAINTEXT`` is the file-level mode of a
#: store that holds at least one of them. The two are different things and
#: they are named differently on purpose — a file that says "plaintext" in
#: one place and "plaintext-fallback" in another is a file nobody can read.
MODE_DPAPI = 'dpapi-user'
ENTRY_PLAINTEXT = 'plaintext'
MODE_PLAINTEXT = 'plaintext-fallback'

#: Set once the plaintext fallback has been announced, so the warning is
#: logged once per process rather than once per write.
_encFallbackWarned = False


def storePath() -> Path:
    """The store file, in the user's data directory."""
    return dataPath(STORE_FILENAME)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def storageMode() -> str:
    """How this host protects what it writes: DPAPI, or the labelled fallback."""
    return MODE_DPAPI if dpapi.is_supported() else MODE_PLAINTEXT


def _readStore() -> dict[str, object]:
    """The store as it is on disk. Missing or unreadable is an empty store."""
    try:
        raw = storePath().read_text('utf-8')
    except OSError:
        # Missing, unreadable, or not a file at all — an empty store. A store
        # that cannot be read is not a store that can be trusted, so the
        # connections read as disconnected and the user re-connects.
        return {}
    try:
        return as_dict(json.loads(raw))
    except json.JSONDecodeError:
        logger.error('secret store at %s is not valid JSON — treating it as empty', storePath())
        return {}


def _writeStore(secrets: dict[str, object]) -> None:
    """Persist the store atomically, with the file-level mode describing it."""
    mode = MODE_DPAPI
    warning = ''
    for entry in secrets.values():
        if as_str(as_dict(entry).get('enc')) != MODE_DPAPI:
            mode = MODE_PLAINTEXT
            warning = (
                'DPAPI is not available on this host — at least one value in this '
                'file is stored in PLAINTEXT. It is labelled as such on purpose.'
            )
            break
    store: dict[str, object] = {
        'version': STORE_VERSION,
        'mode': mode,
        'updatedAt': _now(),
        'secrets': secrets,
    }
    if warning:
        store['warning'] = warning
    path = storePath()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, store, indent=2)


def _encryptValue(value: str) -> dict[str, str]:
    """Encrypt one value, or store it in the labelled plaintext fallback."""
    global _encFallbackWarned
    stamp = _now()
    if dpapi.is_supported():
        blob = dpapi.protect(value.encode('utf-8'))
        return {
            'enc': MODE_DPAPI,
            'blob': base64.b64encode(blob).decode('ascii'),
            'updatedAt': stamp,
        }
    if not _encFallbackWarned:
        _encFallbackWarned = True
        logger.warning(
            'Windows DPAPI is unavailable on this host — secrets are being stored '
            'in PLAINTEXT (labelled as such in %s). Windows encrypts them.',
            STORE_FILENAME,
        )
    return {
        'enc': ENTRY_PLAINTEXT,
        'plaintext': value,
        'updatedAt': stamp,
        'warning': 'NOT ENCRYPTED — DPAPI is unavailable on this host.',
    }


def _decryptValue(entry: object) -> Optional[str]:
    """The plaintext behind one store entry, or ``None`` when it cannot be read."""
    data = as_dict(entry)
    enc = as_str(data.get('enc'))
    if enc == MODE_DPAPI:
        raw = as_str(data.get('blob'))
        if not raw:
            return None
        try:
            blob = base64.b64decode(raw, validate=True)
        except ValueError:
            logger.error('secret store entry is not valid base64 — cannot be read')
            return None
        try:
            return dpapi.unprotect(blob).decode('utf-8')
        except (dpapi.DpapiError, UnicodeDecodeError) as exc:
            # The OS refuses for four indistinguishable reasons: another user,
            # another machine, a tampered file, or a different entropy. Say
            # which OF THOSE we cannot tell, and do not pretend it is empty.
            logger.error('secret store entry could not be decrypted: %s', exc)
            return None
    if enc in (ENTRY_PLAINTEXT, MODE_PLAINTEXT):
        return as_str(data.get('plaintext'))
    return None


def getSecret(key: str) -> Optional[str]:
    """The plaintext behind ``key``, or ``None`` when it is not there.

    ``None`` means "not readable", which is not the same as "not set": a
    blob that fails to decrypt logs an error and reads as absent, so the
    caller re-connects instead of shipping an empty credential.
    """
    if not key:
        return None
    secrets = as_dict(_readStore().get('secrets'))
    if key not in secrets:
        return None
    return _decryptValue(secrets.get(key))


def setSecret(key: str, value: str) -> None:
    """Store one value, encrypted (or in the labelled fallback).

    The value is a STRING. A caller that needs to store a structure encodes
    it first — the store does not know what a JSON document is, and a store
    that guesses is a store that loses data.
    """
    if not key:
        raise ValueError('secret store key must not be empty')
    setSecrets({key: value})


def setSecrets(entries: dict[str, str]) -> None:
    """Store several values at once.

    A value that is already stored unchanged is left alone: DPAPI produces a
    different ciphertext every time, so re-encrypting on every save would
    rewrite the file (and churn its mtime) for no reason.

    The write is all-or-nothing: every value is encrypted first and the
    file is written once, so a failure half way through leaves the previous
    store intact rather than a half-updated one.
    """
    if not entries:
        return
    store = _readStore()
    secrets = as_dict(store.get('secrets'))
    changed = False
    for key, value in entries.items():
        if not key:
            continue
        current = _decryptValue(secrets.get(key))
        if current == value:
            continue
        secrets[key] = _encryptValue(value)
        changed = True
    if not changed:
        return
    _writeStore(secrets)


def deleteSecret(key: str) -> bool:
    """Remove one value. Returns True when something was removed."""
    if not key:
        return False
    store = _readStore()
    secrets = as_dict(store.get('secrets'))
    if key not in secrets:
        return False
    secrets.pop(key, None)
    _writeStore(secrets)
    return True


def pruneSecrets(prefix: str, keep: Iterable[str]) -> list[str]:
    """Remove the keys under ``prefix`` that are not in ``keep``.

    Used when a service is disconnected: its tokens must not sit in the
    store after the user has thrown the connection away.
    """
    keep_set = set(keep)
    store = _readStore()
    secrets = as_dict(store.get('secrets'))
    doomed = [k for k in secrets if str(k).startswith(prefix) and k not in keep_set]
    if not doomed:
        return []
    for key in doomed:
        secrets.pop(key, None)
    _writeStore(secrets)
    return doomed


def listSecretKeys() -> list[str]:
    """The keys in the store. DIAGNOSTIC ONLY — never routed, never listed."""
    return sorted(str(k) for k in as_dict(_readStore().get('secrets')))


def describeStore() -> dict[str, object]:
    """A description of the store that names no secret and no value."""
    store = _readStore()
    secrets = as_dict(store.get('secrets'))
    return {
        'path': str(storePath()),
        'exists': storePath().exists(),
        'version': as_str(store.get('version'), str(STORE_VERSION)),
        'mode': as_str(store.get('mode'), storageMode()),
        'hostMode': storageMode(),
        'count': len(secrets),
        'keys': listSecretKeys(),
    }
