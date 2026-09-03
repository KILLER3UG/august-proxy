"""Part 20 Phase 0 — gateway trust gate (allowlist + pairing codes).

The verified defect: dispatch() ran ANY sender's text through the agent
(guardMode default 'full') and /approve + /deny bypassed the queue — a
stranger who found the bot username could drive tools on the user's PC.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from app.services.gateway import pairing
from app.services.gateway.base import BasePlatformAdapter, MessageEvent, SessionSource


@pytest.fixture(autouse=True)
def _cleanState(isolatedData):
    pairing.getStore().clear()
    yield
    pairing.getStore().clear()


def _setConfig(gateway_cfg: dict) -> None:
    from app.services.config_service import getConfig, saveConfig

    cfg = getConfig()
    cfg['gateway'] = gateway_cfg
    saveConfig(cfg)


# ── allowlist ────────────────────────────────────────────────────────────


def test_default_deny_without_config():
    assert pairing.is_allowed('telegram', 'stranger') is False
    assert pairing.gateDecision('telegram', 'stranger', 'dm') in ('pair', 'ignore')


def test_config_allowlist_grants():
    _setConfig({'allowedUsers': {'telegram': ['owner-1']}})
    assert pairing.is_allowed('telegram', 'owner-1')
    assert pairing.gateDecision('telegram', 'owner-1', 'dm') == 'allow'
    assert pairing.gateDecision('telegram', 'other', 'group') == 'ignore'


def test_env_allowlist_merges(monkeypatch):
    monkeypatch.setenv('TELEGRAM_ALLOWED_USERS', 'env-a, env-b')
    assert pairing.is_allowed('telegram', 'env-a')
    assert pairing.is_allowed('telegram', 'env-b')


def test_unknown_chat_type_fails_closed():
    _setConfig({'pairing': True, 'allowedUsers': {}})
    # Empty/unknown chat_type must NOT get a pairing code (fail closed).
    assert pairing.gateDecision('telegram', 'stranger', '') == 'ignore'


# ── pairing codes ────────────────────────────────────────────────────────


def test_pairing_code_roundtrip():
    _setConfig({'pairing': True})
    code = pairing.getStore().request('telegram', 'stranger', 'chat-9')
    assert code and len(code) == 8
    assert set(code) <= set(pairing._ALPHABET)
    # Ambiguous characters excluded entirely.
    assert not set(code) & set('0O1I')
    granted = pairing.getStore().approve('telegram', code)
    assert granted == 'stranger'
    pairing.grantUser('telegram', granted)
    assert pairing.is_allowed('telegram', 'stranger')
    assert pairing.gateDecision('telegram', 'stranger', 'dm') == 'allow'


def test_code_stored_hashed_not_plaintext():
    _setConfig({'pairing': True})
    code = pairing.getStore().request('telegram', 'u1')
    pending = pairing.getStore().pending['telegram:u1']
    assert code not in pending.codeHash
    assert len(pending.codeHash) == 64  # sha256 hex


def test_wrong_code_rejected_and_lockout():
    _setConfig({'pairing': True})
    pairing.getStore().request('telegram', 'u1')
    for _ in range(pairing._MAX_FAILED):
        assert pairing.getStore().approve('telegram', 'XXXXXXXX') is None
    # Locked out: new requests are refused for the platform.
    assert pairing.getStore().request('telegram', 'u2') is None


def test_rate_limit_one_per_window():
    _setConfig({'pairing': True})
    assert pairing.getStore().request('telegram', 'u1') is not None
    # Same user again → no duplicate live code.
    assert pairing.getStore().request('telegram', 'u1') is None


def test_pending_cap_per_platform():
    _setConfig({'pairing': True})
    for i in range(pairing._MAX_PENDING_PER_PLATFORM):
        assert pairing.getStore().request('telegram', f'u{i}') is not None
    assert pairing.getStore().request('telegram', 'overflow') is None


def test_code_expiry(monkeypatch):
    _setConfig({'pairing': True})
    code = pairing.getStore().request('telegram', 'u1')
    assert code
    key = 'telegram:u1'
    p = pairing.getStore().pending[key]
    monkeypatch.setattr(time, 'time', lambda: p.createdAt + pairing._CODE_TTL_S + 1)
    assert pairing.getStore().approve('telegram', code) is None


# ── dispatch integration ─────────────────────────────────────────────────


class _RecordingAdapter(BasePlatformAdapter):
    platform = 'telegram'

    def __init__(self):
        super().__init__({}, None)
        self.sent: list[tuple[str, str]] = []
        self.turns: list[str] = []

    async def connect(self) -> bool:
        return True

    async def disconnect(self) -> None:
        pass

    async def getChatInfo(self, chat_id: str) -> dict[str, object]:
        return {'name': chat_id, 'type': 'dm'}

    async def sendMessage(self, chat_id, text, **kwargs):
        self.sent.append((chat_id, text))

    async def normalize(self, raw):
        return raw

    async def start(self):
        pass

    async def stop(self):
        pass

    async def _turnTask(self, sessionKey, event):
        self.turns.append(event.text)


def test_dispatch_blocks_stranger_and_issues_code():
    _setConfig({'pairing': True})
    adapter = _RecordingAdapter()
    ev = MessageEvent(source=SessionSource('telegram', 'chat-1', user_id='stranger', chat_type='dm'), text='/approve')
    asyncio.run(adapter.dispatch(ev))
    assert adapter.turns == []  # /approve never reached the bypass handler
    assert adapter.sent and 'Pairing code' in adapter.sent[0][1]


def test_dispatch_silently_ignores_group_stranger():
    _setConfig({'pairing': True})
    adapter = _RecordingAdapter()
    ev = MessageEvent(
        source=SessionSource('telegram', 'grp-1', user_id='stranger', chat_type='group'),
        text='hello everyone',
    )
    asyncio.run(adapter.dispatch(ev))
    assert adapter.turns == []
    assert adapter.sent == []  # no codes in groups, no reply at all


def test_dispatch_allows_paired_user():
    _setConfig({'pairing': True, 'allowedUsers': {'telegram': ['owner']}})
    adapter = _RecordingAdapter()
    ev = MessageEvent(source=SessionSource('telegram', 'chat-2', user_id='owner', chat_type='dm'), text='hi')
    asyncio.run(adapter.dispatch(ev))
    assert adapter.turns == ['hi']
