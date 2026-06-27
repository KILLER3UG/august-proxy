"""Gateway base adapter + SessionBridge tests (A1).

No real workbench state or network calls — the workbench runner, session
factory, and delete fn are all injected/test stubs.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.services.gateway.base import (
    BasePlatformAdapter,
    MessageEvent,
    SessionSource,
    build_session_key,
    should_bypass_active_session,
)
from app.services.gateway.session_bridge import SessionBridge, TurnResult


# ── Stubs ──────────────────────────────────────────────────────────────


class StubRunner:
    """Injected workbench runner: blocks on a gate until released."""

    def __init__(self):
        self.calls: list[dict] = []
        self._gate = asyncio.Event()
        self._gate.set()  # by default, runs immediately

    def hold(self):
        """Wait for release() before the runner returns."""
        self._gate.clear()

    def release(self):
        self._gate.set()

    async def run(self, session_id, message, *,
                  provider="", agent_id="", model="", model_provider="",
                  guard_mode="", emit=None, signal=None):
        self.calls.append({
            "session_id": session_id, "message": message,
            "provider": provider, "agent_id": agent_id,
            "model": model, "model_provider": model_provider,
            "guard_mode": guard_mode,
        })
        # Wait until gate set OR cancelled.
        while not self._gate.is_set():
            if signal and signal.is_set():
                break
            await asyncio.sleep(0.005)
        if emit and not (signal and signal.is_set()):
            emit({"type": "final_output", "content": f"Reply: {message}"})
        if emit:
            emit({"type": "done", "sessionId": session_id})


class MockAdapter(BasePlatformAdapter):
    """Test adapter that records outbound sends."""

    platform = "mock"

    def __init__(self, config=None, bridge=None):
        super().__init__(config, bridge)
        self.sent: list[tuple[str, str]] = []
        self.connected = False

    async def connect(self) -> bool:
        self.connected = True
        return True

    async def disconnect(self) -> None:
        self.connected = False

    async def send_message(self, chat_id: str, text: str, **kwargs) -> None:
        self.sent.append((chat_id, text))

    async def get_chat_info(self, chat_id: str) -> dict:
        return {"name": chat_id, "type": "dm"}

    async def normalize(self, raw: dict) -> MessageEvent | None:
        return MessageEvent(
            source=SessionSource(
                platform="mock",
                chat_id=raw["chat_id"],
                user_id=raw.get("user_id", ""),
                chat_type=raw.get("chat_type", "dm"),
                message_id=raw.get("message_id", ""),
            ),
            text=raw.get("text", ""),
            timestamp=raw.get("timestamp", ""),
            raw=raw,
        )

    async def feed(self, raw: dict) -> None:
        """Test helper — simulate an incoming platform message."""
        await self.handle_incoming(raw)


def make_session_fake(**fields) -> MagicMock:
    obj = MagicMock()
    for k, v in fields.items():
        setattr(obj, k, v)
    return obj


# ── build_session_key tests ───────────────────────────────────────────


class TestBuildSessionKey:
    def test_dm_chat(self):
        source = SessionSource(platform="telegram", chat_id="123", chat_type="dm")
        assert build_session_key(source) == "telegram:123"

    def test_group_with_user(self):
        source = SessionSource(platform="telegram", chat_id="g1", user_id="u1", chat_type="group")
        assert build_session_key(source) == "telegram:g1:u1"

    def test_group_no_user_falls_back_to_chat(self):
        source = SessionSource(platform="slack", chat_id="c1", user_id="", chat_type="channel")
        assert build_session_key(source) == "slack:c1"

    def test_group_per_user_off(self):
        src = SessionSource(platform="telegram", chat_id="g1", user_id="u1", chat_type="group")
        assert build_session_key(src, group_per_user=False) == "telegram:g1"


# ── MessageEvent.get_command tests ────────────────────────────────────


class TestGetCommand:
    def test_slash_stop(self):
        ev = MessageEvent(source=SessionSource("t", "1"), text="/stop")
        assert ev.get_command() == "stop"

    def test_slash_stop_with_botname(self):
        ev = MessageEvent(source=SessionSource("t", "1"), text="/stop@MyBot")
        assert ev.get_command() == "stop"

    def test_slash_new_with_args(self):
        ev = MessageEvent(source=SessionSource("t", "1"), text="/new what is 2+2?")
        assert ev.get_command() == "new"

    def test_plain_text_returns_empty(self):
        ev = MessageEvent(source=SessionSource("t", "1"), text="hello world")
        assert ev.get_command() == ""

    def test_slash_approve(self):
        ev = MessageEvent(source=SessionSource("t", "1"), text="/approve")
        assert ev.get_command() == "approve"


# ── should_bypass_active_session tests ────────────────────────────────


class TestShouldBypass:
    def test_bypass_commands(self):
        for cmd in ("stop", "new", "reset", "approve", "deny", "status"):
            assert should_bypass_active_session(cmd), f"{cmd} should bypass"

    def test_regular_not_bypass(self):
        assert not should_bypass_active_session("help")
        assert not should_bypass_active_session("")


# ── SessionBridge unit tests ──────────────────────────────────────────


class TestSessionBridge:
    @pytest.fixture
    def tmp_map(self, tmp_path: Path):
        return tmp_path / "map.json"

    def test_session_id_for_creates_and_persists(self, tmp_map: Path, monkeypatch):
        fake_session = make_session_fake(id="wb_abc123")
        sf = lambda **kw: fake_session
        bridge = SessionBridge(map_path=tmp_map, session_factory=sf)

        sid = bridge.session_id_for("telegram:1")
        assert sid == "wb_abc123"
        # persisted
        data = json.loads(tmp_map.read_text("utf-8"))
        assert data["telegram:1"] == "wb_abc123"
        # resumes
        sid2 = bridge.session_id_for("telegram:1")
        assert sid2 == "wb_abc123"

    @pytest.mark.asyncio
    async def test_invoke_agent_calls_runner_and_accumulates(self, tmp_map: Path):
        runner = StubRunner()
        fake_session = make_session_fake(id="wb_test")
        bridge = SessionBridge(
            runner=runner.run,
            session_factory=lambda **kw: fake_session,
            map_path=tmp_map,
            provider="p", model="m", agent_id="a",
        )
        result = await bridge.invoke_agent("telegram:1", "hello")
        assert result.text == "Reply: hello"
        assert not result.cancelled
        assert len(runner.calls) == 1
        assert runner.calls[0]["message"] == "hello"
        assert runner.calls[0]["session_id"] == "wb_test"

    @pytest.mark.asyncio
    async def test_runner_receives_config_args(self, tmp_map: Path):
        runner = StubRunner()
        fake_session = make_session_fake(id="wb_cfg")
        bridge = SessionBridge(
            runner=runner.run,
            session_factory=lambda **kw: fake_session,
            map_path=tmp_map,
            provider="my-provider", agent_id="my-agent",
        )
        await bridge.invoke_agent("k", "hi")
        call = runner.calls[0]
        assert call["provider"] == "my-provider"
        assert call["agent_id"] == "my-agent"

    @pytest.mark.asyncio
    async def test_cancel_running_sets_event(self, tmp_map: Path):
        """cancel_running sets the Event so a running invoke_agent sees cancellation."""
        runner = StubRunner()
        runner.hold()
        fake_session = make_session_fake(id="wb_cancel")
        bridge = SessionBridge(
            runner=runner.run,
            session_factory=lambda **kw: fake_session,
            map_path=tmp_map,
        )
        # check _cancels is populated by invoke_agent
        task = asyncio.create_task(bridge.invoke_agent("telegram:1", "hello"))
        await asyncio.sleep(0.02)
        assert "telegram:1" in bridge._cancels
        ev = bridge._cancels["telegram:1"]
        assert not ev.is_set()

        await bridge.cancel_running("telegram:1")
        assert ev.is_set()

        runner.release()
        await task

    @pytest.mark.asyncio
    async def test_reset_session_clears_map_and_factory(self, tmp_map: Path):
        fake_session = make_session_fake(id="wb_rst")
        sf = MagicMock(return_value=fake_session)
        ds = MagicMock(return_value=True)
        bridge = SessionBridge(
            session_factory=sf,
            delete_session=ds,
            map_path=tmp_map,
        )
        _ = bridge.session_id_for("tg:1")
        assert bridge._map["tg:1"] == "wb_rst"
        assert tmp_map.read_text("utf-8") != "{}"

        await bridge.reset_session("tg:1")
        assert "tg:1" not in bridge._map
        ds.assert_called_with("wb_rst")


# ── BasePlatformAdapter integration tests (with MockAdapter + StubBridge) ──


@pytest.mark.asyncio
async def test_first_guard_queues_second_message():
    """A 2nd message for the same session queues while the first is running."""
    runner = StubRunner()
    runner.hold()
    fake_session = make_session_fake(id="wb_q")
    b = SessionBridge(runner=runner.run, session_factory=lambda **kw: fake_session, map_path=Path("/tmp/_notused_q.json"))
    ad = MockAdapter(bridge=b)
    await ad.connect()

    await ad.feed({"text": "first", "chat_id": "1", "chat_type": "dm"})
    await asyncio.sleep(0.02)  # let the task register

    assert "mock:1" in ad._active_sessions

    # 2nd message while first is running
    await ad.feed({"text": "second", "chat_id": "1", "chat_type": "dm"})
    # second should NOT have been sent to the bridge yet
    assert len(runner.calls) == 1  # only first called
    assert runner.calls[0]["message"] == "first"

    # release — first finishes, drain runs second
    runner.release()
    await asyncio.sleep(0.1)  # let drain task complete
    assert len(runner.calls) == 2
    assert runner.calls[1]["message"] == "second"


@pytest.mark.asyncio
async def test_stop_bypass_cancels_running_turn():
    """/stop cancels the running turn and sends 'Stopped.'"""
    runner = StubRunner()
    runner.hold()
    fake_session = make_session_fake(id="wb_stop")
    b = SessionBridge(runner=runner.run, session_factory=lambda **kw: fake_session, map_path=Path("/tmp/_notused_stop.json"))
    ad = MockAdapter(bridge=b)
    await ad.connect()

    await ad.feed({"text": "hello", "chat_id": "1", "chat_type": "dm"})
    await asyncio.sleep(0.02)

    assert "mock:1" in ad._active_sessions

    # /stop bypasses the guard
    await ad.feed({"text": "/stop", "chat_id": "1", "chat_type": "dm"})

    # "Stopped." sent
    assert ("1", "Stopped.") in ad.sent

    runner.release()
    await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_new_bypass_resets_session():
    """/new cancels, resets session mapping, and sends 'New session started.'"""
    runner = StubRunner()
    runner.hold()
    fake_session = make_session_fake(id="wb_new")
    b = SessionBridge(runner=runner.run, session_factory=lambda **kw: fake_session, map_path=Path("/tmp/_notused_new.json"))
    ad = MockAdapter(bridge=b)
    await ad.connect()

    # Create a session mapping
    _ = b.session_id_for("mock:1")
    assert "mock:1" in b._map

    await ad.feed({"text": "/new", "chat_id": "1", "chat_type": "dm"})
    # session reset
    assert "mock:1" not in b._map
    assert ("1", "New session started.") in ad.sent

    runner.release()
    await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_stale_lock_heal():
    """If a task entry remains in _active_sessions after completion, it is healed."""
    runner = StubRunner()  # runs immediately (gate set)
    fake_session = make_session_fake(id="wb_heal")
    b = SessionBridge(runner=runner.run, session_factory=lambda **kw: fake_session, map_path=Path("/tmp/_notused_heal.json"))
    ad = MockAdapter(bridge=b)
    await ad.connect()

    # Feed a message that completes immediately
    await ad.feed({"text": "hello", "chat_id": "1", "chat_type": "dm"})
    await asyncio.sleep(0.05)

    # The task may or may not have been removed by the done_callback by now.
    # Simulate a stale entry: manually insert a done task.
    done_task = asyncio.create_task(asyncio.sleep(0))
    await done_task  # complete it
    ad._active_sessions["mock:1"] = done_task

    # Feed another — should heal (task.done() → pop and fall through)
    await ad.feed({"text": "second", "chat_id": "1", "chat_type": "dm"})
    await asyncio.sleep(0.05)

    assert "mock:1" not in ad._active_sessions or ad._active_sessions.get("mock:1") is not done_task
    # second was processed
    assert len(runner.calls) >= 2


@pytest.mark.asyncio
async def test_diff_chat_ids_are_independent():
    """Messages from different chat_ids get different session keys and don't interfere."""
    runner = StubRunner()
    fake_session = make_session_fake(id="wb_i")
    b = SessionBridge(runner=runner.run, session_factory=lambda **kw: make_session_fake(id="wb_indep"), map_path=Path("/tmp/_notused_ind.json"))
    ad = MockAdapter(bridge=b)
    await ad.connect()

    ad.feed_nowait = lambda raw: asyncio.create_task(ad.handle_incoming(raw))

    # Fire two from different chats concurrently
    await asyncio.gather(
        ad.feed({"text": "a", "chat_id": "1", "chat_type": "dm"}),
        ad.feed({"text": "b", "chat_id": "2", "chat_type": "dm"}),
    )
    await asyncio.sleep(0.05)
    assert len(runner.calls) == 2


@pytest.mark.asyncio
async def test_non_bypass_slash_commands_are_queued():
    """A non-bypass slash command (e.g. /help) is treated as a normal message."""
    runner = StubRunner()
    runner.hold()
    fake_session = make_session_fake(id="wb_nb")
    b = SessionBridge(runner=runner.run, session_factory=lambda **kw: fake_session, map_path=Path("/tmp/_notused_nb.json"))
    ad = MockAdapter(bridge=b)
    await ad.connect()

    await ad.feed({"text": "first", "chat_id": "1", "chat_type": "dm"})
    await asyncio.sleep(0.02)

    await ad.feed({"text": "/help", "chat_id": "1", "chat_type": "dm"})

    runner.release()
    await asyncio.sleep(0.1)
    # Both messages were processed (first held, /help queued and then drained)
    assert len(runner.calls) == 2
