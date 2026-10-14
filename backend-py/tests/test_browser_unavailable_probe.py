"""chromium-absent must arrive as BrowserUnavailableError — and nothing else.

Playwright is a declared dependency, so the common failure is the OPPOSITE of
an ImportError: the package imports fine and only the binary is missing. That
case used to surface as Playwright's own "Executable doesn't exist" out of
``launch()`` — un-wrapped, un-actionable, escaping every browser tool (and any
new caller) because handlers only catch ``BrowserUnavailableError``.

These pin the probe, the launch wrap, and the one sanctioned loopback
exception the artifact judge rides (``allow_loopback=True`` on a session that
is never handed to a model-facing tool — the SSRF guard itself stays put).
"""

from __future__ import annotations

import pytest
from app.services.browser import session_manager as sm


@pytest.fixture(autouse=True)
def _clean_sessions():
    sm._sessions.clear()
    yield
    sm._sessions.clear()


def test_probe_finds_nothing_when_no_roots(monkeypatch):
    monkeypatch.setattr(sm, '_BROWSER_ROOTS', ())
    monkeypatch.delenv('PLAYWRIGHT_BROWSERS_PATH', raising=False)
    assert sm._findChromiumExecutable() == ''


def test_probe_finds_an_installed_binary(monkeypatch, tmp_path):
    binary = tmp_path / 'chromium-1234' / 'chrome-win' / 'chrome.exe'
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b'x')
    monkeypatch.setattr(sm, '_BROWSER_ROOTS', (str(tmp_path),))
    monkeypatch.delenv('PLAYWRIGHT_BROWSERS_PATH', raising=False)
    assert sm._findChromiumExecutable() == str(binary)


async def test_start_engine_raises_the_catchable_type_when_binary_absent(monkeypatch):
    monkeypatch.setattr(sm, '_findChromiumExecutable', lambda: '')
    with pytest.raises(sm.BrowserUnavailableError) as ei:
        await sm._startEngine()
    # The receipt names the action that fixes it.
    assert 'playwright install chromium' in str(ei.value)


async def test_launch_failure_is_wrapped_into_the_catchable_type(monkeypatch):
    class _BogusLauncher:
        async def launch(self, **_kw):
            raise RuntimeError("Executable doesn't exist")

    class _BogusPw:
        chromium = _BogusLauncher()

    async def _fake_start():
        return _BogusPw()

    monkeypatch.setattr(sm, '_startEngine', _fake_start)
    with pytest.raises(sm.BrowserUnavailableError) as ei:
        await sm.getOrCreateSession('judge-session')
    assert 'playwright install chromium' in str(ei.value)
    # The original error is chained, not swallowed.
    assert isinstance(ei.value.__cause__, RuntimeError)
    assert sm._sessions == {}


# ── the guard's one sanctioned loopback exception ───────────────────────────


class _FakeRequest:
    def __init__(self, url: str) -> None:
        self.url = url


class _FakeRoute:
    def __init__(self, url: str) -> None:
        self.request = _FakeRequest(url)
        self.continued = False
        self.aborted_with: str | None = None

    async def continue_(self) -> None:
        self.continued = True

    async def abort(self, reason: str = 'failed') -> None:
        self.aborted_with = reason


class _FakeContext:
    def __init__(self) -> None:
        self.routes: list[str] = []

    async def route(self, pattern: str, _handler) -> None:
        self.routes.append(pattern)


class _FakePage:
    def __init__(self) -> None:
        self.handler = None
        self.context = _FakeContext()

    def on(self, _event: str, _cb) -> None:
        pass

    async def route(self, _pattern: str, handler) -> None:
        self.handler = handler


async def _drive(url: str, *, allow_loopback: bool) -> _FakeRoute:
    session = sm.BrowserSession('judge')
    page = _FakePage()
    await sm._installNavigationGuard(page, session, allow_loopback=allow_loopback)  # type: ignore[arg-type]
    route = _FakeRoute(url)
    await page.handler(route, route.request)  # type: ignore[misc]
    return route


async def test_loopback_still_blocked_for_a_model_facing_session():
    # The default is the guard as it has always been: the judge's exception
    # must not leak into the browser the model drives.
    route = await _drive('http://127.0.0.1:8085/api/workbench/artifact/html?path=x', allow_loopback=False)
    assert route.continued is False


async def test_judge_session_may_reach_its_own_backend():
    route = await _drive('http://127.0.0.1:8085/api/workbench/artifact/html?path=x', allow_loopback=True)
    assert route.continued is True
    assert route.aborted_with is None


async def test_the_carve_out_is_a_path_not_the_whole_host():
    # `allow_loopback` exists so the judge can screenshot August's artifact
    # route. Read as "any loopback URL" it would also let a judged document —
    # which runs inline script and can navigate its own frame — reach
    # /api/providers and have the answer come back as a picture.
    for url in (
        'http://127.0.0.1:8085/api/providers',
        'http://127.0.0.1:8085/api/brain/stores/facts',
        'http://localhost:8085/api/workbench/sessions',
        'http://127.0.0.1:8085/openapi.json',
    ):
        route = await _drive(url, allow_loopback=True)
        assert route.continued is False, url


def test_the_two_loopback_controls_agree():
    # The request guard permits the artifact route; the final-URL re-check has
    # to permit exactly the same thing or the feature is broken one way and
    # leaking the other.
    class _P:
        url = 'http://127.0.0.1:8085/api/workbench/artifact/html?path=x'

    judge = sm.BrowserSession('artifact-judge')
    judge.sanctionedLoopbackOnly = True
    assert sm.assertFinalUrlAllowed(_P(), judge) is None

    class _Moved:
        url = 'http://127.0.0.1:8085/api/providers'

    assert sm.assertFinalUrlAllowed(_Moved(), judge) is not None
    plain = sm.BrowserSession('workbench-1')
    assert sm.assertFinalUrlAllowed(_P(), plain) is not None


async def test_allowlist_exception_does_not_open_other_private_hosts():
    # Loopback is the sanctioned target, not the whole private range.
    route = await _drive('http://169.254.169.254/latest/meta-data/', allow_loopback=True)
    assert route.continued is False
