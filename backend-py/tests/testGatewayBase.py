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
    buildSessionKey,
    shouldBypassActiveSession,
)
from app.services.gateway.session_bridge import SessionBridge, TurnResult


class StubRunner:
    """Injected workbench runner: blocks on a gate until released."""

    def __init__(self):
        self.calls: list[dict] = []
        self._gate = asyncio.Event()
        self._gate.set()

    def hold(self):
        """Wait for release() before the runner returns."""
        self._gate.clear()

    def release(self):
        self._gate.set()

    async def run(
        self,
        sessionId,
        message,
        *,
        provider='',
        agentId='',
        model='',
        modelProvider='',
        guardMode='',
        emit=None,
        signal=None,
    ):
        self.calls.append(
            {
                'sessionId': sessionId,
                'message': message,
                'provider': provider,
                'agentId': agentId,
                'model': model,
                'modelProvider': modelProvider,
                'guardMode': guardMode,
            }
        )
        while not self._gate.is_set():
            if signal and signal.is_set():
                break
            await asyncio.sleep(0.005)
        if emit and (not (signal and signal.is_set())):
            emit({'type': 'final_output', 'content': f'Reply: {message}'})
        if emit:
            emit({'type': 'done', 'sessionId': sessionId})


class MockAdapter(BasePlatformAdapter):
    """Test adapter that records outbound sends."""

    platform = 'mock'

    def __init__(self, config=None, bridge=None):
        super().__init__(config, bridge)
        self.sent: list[tuple[str, str]] = []
        self.connected = False

    async def connect(self) -> bool:
        self.connected = True
        return True

    async def disconnect(self) -> None:
        self.connected = False

    async def sendMessage(self, chat_id: str, text: str, **kwargs) -> None:
        self.sent.append((chat_id, text))

    async def getChatInfo(self, chat_id: str) -> dict:
        return {'name': chat_id, 'type': 'dm'}

    async def normalize(self, raw: dict) -> MessageEvent | None:
        return MessageEvent(
            source=SessionSource(
                platform='mock',
                chat_id=raw['chatId'],
                user_id=raw.get('userId', ''),
                chat_type=raw.get('chatType', 'dm'),
                message_id=raw.get('messageId', ''),
            ),
            text=raw.get('text', ''),
            timestamp=raw.get('timestamp', ''),
            raw=raw,
        )

    async def feed(self, raw: dict) -> None:
        """Test helper — simulate an incoming platform message."""
        await self.handleIncoming(raw)


def makeSessionFake(**fields) -> MagicMock:
    obj = MagicMock()
    for k, v in fields.items():
        setattr(obj, k, v)
    return obj


class TestBuildSessionKey:
    def testDmChat(self):
        source = SessionSource(platform='telegram', chat_id='123', chat_type='dm')
        assert buildSessionKey(source) == 'telegram:123'

    def testGroupWithUser(self):
        source = SessionSource(platform='telegram', chat_id='g1', user_id='u1', chat_type='group')
        assert buildSessionKey(source) == 'telegram:g1:u1'

    def testGroupNoUserFallsBackToChat(self):
        source = SessionSource(platform='slack', chat_id='c1', user_id='', chat_type='channel')
        assert buildSessionKey(source) == 'slack:c1'

    def testGroupPerUserOff(self):
        src = SessionSource(platform='telegram', chat_id='g1', user_id='u1', chat_type='group')
        assert buildSessionKey(src, groupPerUser=False) == 'telegram:g1'


class TestGetCommand:
    def testSlashStop(self):
        ev = MessageEvent(source=SessionSource('t', '1'), text='/stop')
        assert ev.getCommand() == 'stop'

    def testSlashStopWithBotname(self):
        ev = MessageEvent(source=SessionSource('t', '1'), text='/stop@MyBot')
        assert ev.getCommand() == 'stop'

    def testSlashNewWithArgs(self):
        ev = MessageEvent(source=SessionSource('t', '1'), text='/new what is 2+2?')
        assert ev.getCommand() == 'new'

    def testPlainTextReturnsEmpty(self):
        ev = MessageEvent(source=SessionSource('t', '1'), text='hello world')
        assert ev.getCommand() == ''

    def testSlashApprove(self):
        ev = MessageEvent(source=SessionSource('t', '1'), text='/approve')
        assert ev.getCommand() == 'approve'


class TestShouldBypass:
    def testBypassCommands(self):
        for cmd in ('stop', 'new', 'reset', 'approve', 'deny', 'status'):
            assert shouldBypassActiveSession(cmd), f'{cmd} should bypass'

    def testRegularNotBypass(self):
        assert not shouldBypassActiveSession('help')
        assert not shouldBypassActiveSession('')


class TestSessionBridge:
    @pytest.fixture
    def tmpMap(self, tmp_path: Path):
        return tmp_path / 'map.json'

    def testSessionIdForCreatesAndPersists(self, tmpMap: Path, monkeypatch):
        fakeSession = makeSessionFake(id='wb_abc123')
        def _sf(**kw):
            return fakeSession
        bridge = SessionBridge(mapPath=tmpMap, sessionFactory=_sf)
        sid = bridge.sessionIdFor('telegram:1')
        assert sid == 'wb_abc123'
        data = json.loads(tmpMap.read_text('utf-8'))
        assert data['telegram:1'] == 'wb_abc123'
        sid2 = bridge.sessionIdFor('telegram:1')
        assert sid2 == 'wb_abc123'

    @pytest.mark.asyncio
    async def testInvokeAgentCallsRunnerAndAccumulates(self, tmpMap: Path):
        runner = StubRunner()
        fakeSession = makeSessionFake(id='wb_test')
        bridge = SessionBridge(
            runner=runner.run,
            sessionFactory=lambda **kw: fakeSession,
            mapPath=tmpMap,
            provider='p',
            model='m',
            agentId='a',
        )
        result = await bridge.invokeAgent('telegram:1', 'hello')
        assert result.text == 'Reply: hello'
        assert not result.cancelled
        assert len(runner.calls) == 1
        assert runner.calls[0]['message'] == 'hello'
        assert runner.calls[0]['sessionId'] == 'wb_test'

    @pytest.mark.asyncio
    async def testRunnerReceivesConfigArgs(self, tmpMap: Path):
        runner = StubRunner()
        fakeSession = makeSessionFake(id='wb_cfg')
        bridge = SessionBridge(
            runner=runner.run,
            sessionFactory=lambda **kw: fakeSession,
            mapPath=tmpMap,
            provider='my-provider',
            agentId='my-agent',
        )
        await bridge.invokeAgent('k', 'hi')
        call = runner.calls[0]
        assert call['provider'] == 'my-provider'
        assert call['agentId'] == 'my-agent'

    @pytest.mark.asyncio
    async def testCancelRunningSetsEvent(self, tmpMap: Path):
        """cancel_running sets the Event so a running invoke_agent sees cancellation."""
        runner = StubRunner()
        runner.hold()
        fakeSession = makeSessionFake(id='wb_cancel')
        bridge = SessionBridge(runner=runner.run, sessionFactory=lambda **kw: fakeSession, mapPath=tmpMap)
        task = asyncio.create_task(bridge.invokeAgent('telegram:1', 'hello'))
        await asyncio.sleep(0.02)
        assert 'telegram:1' in bridge._cancels
        ev = bridge._cancels['telegram:1']
        assert not ev.is_set()
        await bridge.cancelRunning('telegram:1')
        assert ev.is_set()
        runner.release()
        await task

    @pytest.mark.asyncio
    async def testResetSessionClearsMapAndFactory(self, tmpMap: Path):
        fakeSession = makeSessionFake(id='wb_rst')
        sf = MagicMock(return_value=fakeSession)
        ds = MagicMock(return_value=True)
        bridge = SessionBridge(sessionFactory=sf, deleteSession=ds, mapPath=tmpMap)
        __ = bridge.sessionIdFor('tg:1')
        assert bridge._map['tg:1'] == 'wb_rst'
        assert tmpMap.read_text('utf-8') != '{}'
        await bridge.resetSession('tg:1')
        assert 'tg:1' not in bridge._map
        ds.assert_called_with('wb_rst')


@pytest.mark.asyncio
async def testFirstGuardQueuesSecondMessage():
    """A 2nd message for the same session queues while the first is running."""
    runner = StubRunner()
    runner.hold()
    fakeSession = makeSessionFake(id='wb_q')
    b = SessionBridge(runner=runner.run, sessionFactory=lambda **kw: fakeSession, mapPath=Path('/tmp/_notused_q.json'))
    ad = MockAdapter(bridge=b)
    await ad.connect()
    await ad.feed({'text': 'first', 'chatId': '1', 'chatType': 'dm'})
    await asyncio.sleep(0.02)
    assert 'mock:1' in ad._activeSessions
    await ad.feed({'text': 'second', 'chatId': '1', 'chatType': 'dm'})
    assert len(runner.calls) == 1
    assert runner.calls[0]['message'] == 'first'
    runner.release()
    await asyncio.sleep(0.1)
    assert len(runner.calls) == 2
    assert runner.calls[1]['message'] == 'second'


@pytest.mark.asyncio
async def testStopBypassCancelsRunningTurn():
    """/stop cancels the running turn and sends 'Stopped.'"""
    runner = StubRunner()
    runner.hold()
    fakeSession = makeSessionFake(id='wb_stop')
    b = SessionBridge(
        runner=runner.run, sessionFactory=lambda **kw: fakeSession, mapPath=Path('/tmp/_notused_stop.json')
    )
    ad = MockAdapter(bridge=b)
    await ad.connect()
    await ad.feed({'text': 'hello', 'chatId': '1', 'chatType': 'dm'})
    await asyncio.sleep(0.02)
    assert 'mock:1' in ad._activeSessions
    await ad.feed({'text': '/stop', 'chatId': '1', 'chatType': 'dm'})
    assert ('1', 'Stopped.') in ad.sent
    runner.release()
    await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def testNewBypassResetsSession():
    """/new cancels, resets session mapping, and sends 'New session started.'"""
    runner = StubRunner()
    runner.hold()
    fakeSession = makeSessionFake(id='wb_new')
    b = SessionBridge(
        runner=runner.run, sessionFactory=lambda **kw: fakeSession, mapPath=Path('/tmp/_notused_new.json')
    )
    ad = MockAdapter(bridge=b)
    await ad.connect()
    __ = b.sessionIdFor('mock:1')
    assert 'mock:1' in b._map
    await ad.feed({'text': '/new', 'chatId': '1', 'chatType': 'dm'})
    assert 'mock:1' not in b._map
    assert ('1', 'New session started.') in ad.sent
    runner.release()
    await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def testStaleLockHeal():
    """If a task entry remains in _active_sessions after completion, it is healed."""
    runner = StubRunner()
    fakeSession = makeSessionFake(id='wb_heal')
    b = SessionBridge(
        runner=runner.run, sessionFactory=lambda **kw: fakeSession, mapPath=Path('/tmp/_notused_heal.json')
    )
    ad = MockAdapter(bridge=b)
    await ad.connect()
    await ad.feed({'text': 'hello', 'chatId': '1', 'chatType': 'dm'})
    await asyncio.sleep(0.05)
    doneTask = asyncio.create_task(asyncio.sleep(0))
    await doneTask
    ad._activeSessions['mock:1'] = doneTask
    await ad.feed({'text': 'second', 'chatId': '1', 'chatType': 'dm'})
    await asyncio.sleep(0.05)
    assert 'mock:1' not in ad._activeSessions or ad._activeSessions.get('mock:1') is not doneTask
    assert len(runner.calls) >= 2


@pytest.mark.asyncio
async def testDiffChatIdsAreIndependent():
    """Messages from different chat_ids get different session keys and don't interfere."""
    runner = StubRunner()
    b = SessionBridge(
        runner=runner.run,
        sessionFactory=lambda **kw: makeSessionFake(id='wb_indep'),
        mapPath=Path('/tmp/_notused_ind.json'),
    )
    ad = MockAdapter(bridge=b)
    await ad.connect()
    ad.feed_nowait = lambda raw: asyncio.create_task(ad.handle_incoming(raw))
    await asyncio.gather(
        ad.feed({'text': 'a', 'chatId': '1', 'chatType': 'dm'}), ad.feed({'text': 'b', 'chatId': '2', 'chatType': 'dm'})
    )
    await asyncio.sleep(0.05)
    assert len(runner.calls) == 2


@pytest.mark.asyncio
async def testNonBypassSlashCommandsAreQueued():
    """A non-bypass slash command (e.g. /help) is treated as a normal message."""
    runner = StubRunner()
    runner.hold()
    fakeSession = makeSessionFake(id='wb_nb')
    b = SessionBridge(runner=runner.run, sessionFactory=lambda **kw: fakeSession, mapPath=Path('/tmp/_notused_nb.json'))
    ad = MockAdapter(bridge=b)
    await ad.connect()
    await ad.feed({'text': 'first', 'chatId': '1', 'chatType': 'dm'})
    await asyncio.sleep(0.02)
    await ad.feed({'text': '/help', 'chatId': '1', 'chatType': 'dm'})
    runner.release()
    await asyncio.sleep(0.1)
    assert len(runner.calls) == 2
