"""Gateway trust gate (Part 20 Phase 0) — allowlist + pairing codes.

Verified defect this closes: ``BasePlatformAdapter.dispatch`` ran ANY
sender's text through the agent with ``guardMode`` from config (default
``full``), and ``/approve``/``/deny`` bypassed the queue — a stranger who
discovered the bot username could approve workbench plans and drive tools
on the user's machine.

Rules (spec: docs/plans/2026-09-01-messaging-gateway.md §Phase 0):

* **Allowlist, default-deny.** ``gateway.allowedUsers: {platform: [user_id…]}``
  in config.json, plus env ``{PLATFORM}_ALLOWED_USERS`` (comma list).
* **Pairing codes.** An unknown DM while ``gateway.pairing`` is true gets a
  one-shot code: 8 chars from an unambiguous 32-char alphabet (no 0/O/1/I),
  CSPRNG, stored as salted SHA-256 (never plaintext), TTL 1 h, 1 request per
  user per 10 min, max 3 pending per platform, lockout 1 h after 5 failed
  approvals. Approval appends the user id to the config allowlist (live
  effect, no restart).
* **Groups**: unauthorized users in a group are silently ignored — codes are
  never issued in group context (a group member must DM the bot).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Optional

from app.json_narrowing import as_bool, as_dict, as_list

logger = logging.getLogger(__name__)

# Unambiguous 32-char alphabet (no 0/O/1/I).
_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
_CODE_LEN = 8
_CODE_TTL_S = 3600.0
_REQUEST_WINDOW_S = 600.0
_MAX_PENDING_PER_PLATFORM = 3
_MAX_FAILED = 5
_LOCKOUT_S = 3600.0


def _envAllowed(platform: str) -> list[str]:
    raw = os.environ.get(f'{platform.upper()}_ALLOWED_USERS', '')
    return [t.strip() for t in raw.split(',') if t.strip()]


def configAllowedUsers() -> dict[str, list[str]]:
    """Merged allowlist: config.json ``gateway.allowedUsers`` + env overrides."""
    from app.services.config_service import getConfig

    cfg = as_dict(getConfig().get('gateway'), {})
    stored = {
        platform: [str(u) for u in as_list(ids, [])]
        for platform, ids in as_dict(cfg.get('allowedUsers'), {}).items()
    }
    out: dict[str, list[str]] = {}
    for platform in set(stored) | {'telegram', 'slack', 'discord'}:
        env = _envAllowed(platform)
        merged = list(dict.fromkeys([*(stored.get(platform) or []), *env]))
        if merged:
            out[platform] = merged
    return out


def is_allowed(platform: str, user_id: str) -> bool:
    if not user_id:
        return False
    return user_id in configAllowedUsers().get(platform, [])


def pairingEnabled() -> bool:
    from app.services.config_service import getConfig

    cfg = as_dict(getConfig().get('gateway'), {})
    return as_bool(cfg.get('pairing'), False)


def grantUser(platform: str, user_id: str) -> None:
    """Append a user id to the config allowlist (live effect, no restart)."""
    from app.services.config_service import getConfig, saveConfig

    config = getConfig()
    gateway = dict(as_dict(config.get('gateway'), {}))
    allowed = {k: [str(u) for u in as_list(v, [])] for k, v in as_dict(gateway.get('allowedUsers'), {}).items()}
    ids = allowed.setdefault(platform, [])
    if user_id not in ids:
        ids.append(user_id)
    gateway['allowedUsers'] = allowed
    config['gateway'] = gateway
    saveConfig(config)


def revokeUser(platform: str, user_id: str) -> bool:
    from app.services.config_service import getConfig, saveConfig

    config = getConfig()
    gateway = dict(as_dict(config.get('gateway'), {}))
    allowed = {k: [str(u) for u in as_list(v, [])] for k, v in as_dict(gateway.get('allowedUsers'), {}).items()}
    ids = allowed.get(platform) or []
    if user_id not in ids:
        return False
    allowed[platform] = [u for u in ids if u != user_id]
    gateway['allowedUsers'] = allowed
    config['gateway'] = gateway
    saveConfig(config)
    return True


@dataclass
class _Pending:
    platform: str
    user_id: str
    codeHash: str
    salt: str
    createdAt: float
    chatId: str = ''


@dataclass
class PairingStore:
    """In-process pairing-code store (codes are ephemeral by design: an
    unapproved code dies with the process, which is the safe direction)."""

    pending: dict[str, _Pending] = field(default_factory=dict)  # key: platform:user
    lastRequestAt: dict[str, float] = field(default_factory=dict)
    failedCount: dict[str, int] = field(default_factory=dict)  # key: platform
    lockoutUntil: dict[str, float] = field(default_factory=dict)  # key: platform

    def clear(self) -> None:
        self.pending.clear()
        self.lastRequestAt.clear()
        self.failedCount.clear()
        self.lockoutUntil.clear()

    def _prune(self) -> None:
        now = time.time()
        for key, p in list(self.pending.items()):
            if now - p.createdAt > _CODE_TTL_S:
                self.pending.pop(key, None)

    def request(self, platform: str, user_id: str, chat_id: str = '') -> Optional[str]:
        """Create (or return the live) pairing code for an unknown DM user.

        Returns None when rate-limited, over the pending cap, or locked out.
        """
        self._prune()
        now = time.time()
        if now < self.lockoutUntil.get(platform, 0.0):
            return None
        key = f'{platform}:{user_id}'
        existing = self.pending.get(key)
        if existing is not None:
            return None  # one live code per user; the first reply stands
        if now - self.lastRequestAt.get(key, 0.0) < _REQUEST_WINDOW_S:
            return None
        pending_for_platform = sum(1 for p in self.pending.values() if p.platform == platform)
        if pending_for_platform >= _MAX_PENDING_PER_PLATFORM:
            return None
        code = ''.join(secrets.choice(_ALPHABET) for _ in range(_CODE_LEN))
        salt = secrets.token_hex(8)
        self.pending[key] = _Pending(
            platform=platform,
            user_id=user_id,
            codeHash=_hash(code, salt),
            salt=salt,
            createdAt=now,
            chatId=chat_id,
        )
        self.lastRequestAt[key] = now
        return code

    def approve(self, platform: str, code: str) -> Optional[str]:
        """Consume a code; returns the granted user_id or None (bad/expired).

        Wrong-code attempts count toward the per-platform lockout.
        """
        self._prune()
        needle = code.strip().upper()
        for key, p in list(self.pending.items()):
            if p.platform != platform:
                continue
            if hmac.compare_digest(p.codeHash, _hash(needle, p.salt)):
                self.pending.pop(key, None)
                self.failedCount[platform] = 0
                return p.user_id
        failed = self.failedCount.get(platform, 0) + 1
        self.failedCount[platform] = failed
        if failed >= _MAX_FAILED:
            self.lockoutUntil[platform] = time.time() + _LOCKOUT_S
            self.failedCount[platform] = 0
            self.pending = {k: v for k, v in self.pending.items() if v.platform != platform}
        return None

    def listPending(self) -> list[dict[str, object]]:
        self._prune()
        return [
            {
                'platform': p.platform,
                'userId': p.user_id,
                'requestedAt': p.createdAt,
                'expiresAt': p.createdAt + _CODE_TTL_S,
            }
            for p in self.pending.values()
        ]


def _hash(code: str, salt: str) -> str:
    return hashlib.sha256(f'{salt}:{code}'.encode('utf-8')).hexdigest()


_store = PairingStore()


def getStore() -> PairingStore:
    return _store


def gateDecision(platform: str, user_id: str, chat_type: str) -> str:
    """'allow' | 'pair' | 'ignore' for an inbound message (pre-dispatch).

    DM from an unknown user with pairing on → 'pair' (adapter replies with a
    code); anything else unknown → 'ignore' (silence; groups never get codes).
    An unknown/empty chat_type fails closed to 'ignore' — pairing codes are
    only issued for chats positively identified as DMs.
    """
    if is_allowed(platform, user_id):
        return 'allow'
    if pairingEnabled() and (chat_type or '').lower() in ('dm', 'private', 'direct'):
        return 'pair'
    return 'ignore'
