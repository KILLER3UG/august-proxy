"""Chunk 4 — tool loop: no round cap, guaranteed terminal event, observability.

Asserts the core issue-#2 fix:
  * The loop runs >10 rounds and only stops when the cancel signal is set
    (the old MAX_MANAGED_TOOL_ROUNDS=10 cap is gone).
  * A terminal ``done`` event is ALWAYS emitted — on normal completion,
    on a model error, and on cancellation — even if persistence raises.

Uses a stub provider/client whose ``messages_stream`` yields controllable
Anthropic stream events so we can drive the loop deterministically.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import pytest

from app.services.workbench import workbench as wb


# ── Stubs ────────────────────────────────────────────────────────────


class StubClient:
    """Stub upstream client yielding scripted Anthropic stream events."""

    def __init__(self, mode: str = "tool_forever", cancel_after: int | None = None):
        self.mode = mode
        self.call_count = 0
        # When set, messages_stream yields control to the event loop each
        # round so a cooperative canceller (or the loop's own _is_cancelled
        # check at the top of the next round) can interrupt the spin.
        self.cancel_after = cancel_after
        self._cancel_event: asyncio.Event | None = None

    def resolve_api_key(self) -> str:
        return "stub-key"

    def bind_cancel(self, event: asyncio.Event) -> None:
        self._cancel_event = event

    async def messages_stream(self, body) -> AsyncIterator[dict[str, Any]]:
        self.call_count += 1
        round_n = self.call_count

        # Cooperatively yield to the event loop so a canceller task can run.
        await asyncio.sleep(0)

        if self.mode == "tool_forever":
            # Always emit one tool_use block → loop continues indefinitely.
            yield {"_event_type": "content_block_start",
                   "content_block": {"type": "tool_use",
                                     "id": f"toolu_{round_n}",
                                     "name": "list_skills"}}
            yield {"_event_type": "content_block_delta",
                   "delta": {"type": "input_json_delta", "partial_json": "{}"}}
            yield {"_event_type": "content_block_stop"}
            yield {"_event_type": "message_delta",
                   "usage": {"input_tokens": 10, "output_tokens": 5}}
            # If a cancel-after threshold is set, flip the cancel signal
            # once we've produced enough rounds to prove the cap is gone.
            if (self.cancel_after is not None
                    and self.call_count >= self.cancel_after
                    and self._cancel_event is not None
                    and not self._cancel_event.is_set()):
                self._cancel_event.set()
        elif self.mode == "text_once":
            # First call: text reply (no tools) → normal completion.
            yield {"_event_type": "content_block_start",
                   "content_block": {"type": "text", "text": "Hello."}}
            yield {"_event_type": "message_delta",
                   "usage": {"input_tokens": 10, "output_tokens": 5}}
        elif self.mode == "error":
            yield {"_event_type": "error", "error": {"type": "upstream_error"}}


STUB_PROVIDER = {
    "name": "stub-anthropic",
    "api_mode": "anthropic_messages",
    "default_model": "stub-claude",
    "model_profiles": {},
}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """Redirect the data dir + clear in-memory session state."""
    from app.config import settings
    monkeypatch.setenv("AUGUST_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    settings.reload()

    # Clear workbench in-memory session store.
    monkeypatch.setattr(wb, "_sessions", {})
    # Avoid background tasks lingering past the test.
    monkeypatch.setattr(asyncio, "create_task", lambda coro, **kw: asyncio.ensure_future(coro))

    # Stub provider resolution + client lookup + system prompt.
    monkeypatch.setattr(wb, "_resolve_workbench_provider", lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr(wb, "_resolve_model", lambda p, hint="": "stub-claude")
    monkeypatch.setattr(wb, "build_system_prompt", lambda session: "stub system prompt")

    import app.providers.clients as clients_mod
    stub_holder: dict[str, Any] = {}

    def fake_get_client(provider):
        return stub_holder["client"]

    monkeypatch.setattr(clients_mod, "get_client", fake_get_client)
    # The workbench imports get_client lazily inside _call_anthropic_workbench;
    # patch it on the module the function reads from at call time.
    monkeypatch.setattr("app.providers.clients.get_client", fake_get_client)

    yield stub_holder


# ── Helpers ──────────────────────────────────────────────────────────


def _captured_events():
    events: list[dict[str, Any]] = []
    return events


def _emit_to(events: list[dict[str, Any]]):
    def emit(ev: dict[str, Any]) -> None:
        events.append(ev)
    return emit


# ── No round cap ─────────────────────────────────────────────────────


class TestNoRoundCap:
    @pytest.mark.asyncio
    async def test_loop_exceeds_ten_rounds_and_stops_on_cancel(self, _isolate):
        cancel = asyncio.Event()
        stub = StubClient(mode="tool_forever", cancel_after=12)
        stub.bind_cancel(cancel)
        _isolate["client"] = stub

        events = _captured_events()

        await wb.send_workbench_message_stream(
            session_id="wb_test_loop",
            message="loop test",
            model="stub-claude",
            emit=_emit_to(events),
            signal=cancel,
        )

        # The loop ran MORE than the old cap of 10.
        assert stub.call_count >= 11, f"loop stopped too early: {stub.call_count} rounds"

        types = [e["type"] for e in events]
        assert "done" in types, "terminal 'done' event not emitted"

    @pytest.mark.asyncio
    async def test_normal_completion_emits_done(self, _isolate):
        stub = StubClient(mode="text_once")
        _isolate["client"] = stub

        events = _captured_events()
        await wb.send_workbench_message_stream(
            session_id="wb_test_done",
            message="hi",
            model="stub-claude",
            emit=_emit_to(events),
        )

        types = [e["type"] for e in events]
        assert "done" in types
        assert stub.call_count == 1  # text reply → one round, no tools


# ── Terminal event always emitted ─────────────────────────────────────


class TestTerminalEventGuaranteed:
    @pytest.mark.asyncio
    async def test_done_on_model_error(self, _isolate):
        stub = StubClient(mode="error")
        _isolate["client"] = stub

        events = _captured_events()
        await wb.send_workbench_message_stream(
            session_id="wb_test_err",
            message="hi",
            model="stub-claude",
            emit=_emit_to(events),
        )

        types = [e["type"] for e in events]
        assert "error" in types
        assert "done" in types, "done must be emitted even after a model error"

    @pytest.mark.asyncio
    async def test_done_on_cancellation_before_first_round(self, _isolate):
        stub = StubClient(mode="tool_forever")
        _isolate["client"] = stub

        cancel = asyncio.Event()
        cancel.set()  # already cancelled before we start

        events = _captured_events()
        await wb.send_workbench_message_stream(
            session_id="wb_test_cancel",
            message="hi",
            model="stub-claude",
            emit=_emit_to(events),
            signal=cancel,
        )

        types = [e["type"] for e in events]
        assert "done" in types, "done must be emitted on cancellation"
        # Loop should not have called the model (cancelled at top of round 1).
        assert stub.call_count == 0

    @pytest.mark.asyncio
    async def test_done_emitted_even_if_save_sessions_raises(self, _isolate, monkeypatch):
        """The try/finally guarantees done even when persistence fails."""
        # Pre-create the session so create_workbench_session() (which also
        # calls save_sessions) isn't the call that hits the boom — we want
        # the POST-LOOP save_sessions to be the one that raises, to prove
        # the finally still emits done.
        session = wb.create_workbench_session(provider="stub-anthropic")
        sid = session.id

        stub = StubClient(mode="text_once")
        _isolate["client"] = stub

        call_count = {"n": 0}
        real_save = wb.save_sessions

        def boom():
            call_count["n"] += 1
            # Only the post-loop save_sessions should raise; any earlier
            # calls (none expected here) succeed.
            if call_count["n"] >= 1:
                raise RuntimeError("disk full")
            real_save()

        monkeypatch.setattr(wb, "save_sessions", boom)

        events = _captured_events()
        await wb.send_workbench_message_stream(
            session_id=sid,
            message="hi",
            model="stub-claude",
            emit=_emit_to(events),
        )

        types = [e["type"] for e in events]
        assert "done" in types, "done must be emitted even if save_sessions raises"
