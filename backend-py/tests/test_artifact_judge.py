"""Artifact judge — render_pages rasterization + judge_artifact verdicts.

Vision calls are monkeypatched (no provider in tests); PDF rendering is
real (pypdfium2 rasterizes a Pillow-generated one-page PDF).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.services.tools import artifact_judge as aj
from PIL import Image


def test_parse_pages_spec():
    assert aj.parse_pages_spec('1-3,5', 10) == [1, 2, 3, 5]
    assert aj.parse_pages_spec('2-2', 10) == [2]
    assert aj.parse_pages_spec('99', 3) == [1, 2, 3]  # out of range -> default head
    assert aj.parse_pages_spec('garbage', 2) == [1, 2]
    assert aj.parse_pages_spec('', 20) == list(range(1, 9))  # cap at 8


def test_find_soffice_probe(monkeypatch):
    monkeypatch.setattr(aj.shutil, 'which', lambda name: 'X:/LO/soffice.exe' if name == 'soffice' else None)
    assert aj.find_soffice() == 'X:/LO/soffice.exe'
    monkeypatch.setattr(aj.shutil, 'which', lambda name: None)
    monkeypatch.setattr(aj, '_SOFFICE_CANDIDATES', ())
    assert aj.find_soffice() == ''


def _make_pdf(path):
    Image.new('RGB', (300, 400), 'white').save(path, 'PDF')
    return path


def test_render_pdf_pages(tmp_path):
    pdf = _make_pdf(tmp_path / 'deck.pdf')
    out = aj.render_pages(str(pdf), workspace=str(tmp_path))
    assert out['ok'] is True, out
    assert out['renderer'] == 'pypdfium2'
    assert len(out['rendered']) == 1
    png = Path(out['rendered'][0])
    assert png.is_file() and png.stat().st_size > 1000


def test_render_image_input(tmp_path):
    img = tmp_path / 'page.png'
    Image.new('RGB', (100, 100), 'red').save(img, 'PNG')
    out = aj.render_pages(str(img), workspace=str(tmp_path))
    assert out['ok'] is True and out['renderer'] == 'image' and len(out['rendered']) == 1


def test_render_unsupported_ext(tmp_path):
    (tmp_path / 'notes.txt').write_text('x')
    with pytest.raises(ValueError):
        aj.render_pages(str(tmp_path / 'notes.txt'), workspace=str(tmp_path))


def test_doc_without_soffice_returns_receipt(tmp_path, monkeypatch):
    (tmp_path / 'deck.pptx').write_bytes(b'PK\x03\x04fake')
    monkeypatch.setattr(aj, 'find_soffice', lambda: '')
    out = aj.render_pages(str(tmp_path / 'deck.pptx'), workspace=str(tmp_path))
    assert out['ok'] is False
    assert 'LibreOffice' in out['error']


@pytest.mark.asyncio
async def test_judge_parses_fenced_verdict(tmp_path, monkeypatch):
    pdf = _make_pdf(tmp_path / 'r.pdf')

    async def fake_vision(image_path, question, url='', extra_images=None):
        assert 'ACCEPTANCE' in question.upper() or 'acceptance' in question
        return '```json\n' + json.dumps({
            'overall': 'fix',
            'pages': [{'page': 1, 'pass': False, 'issues': ['title overlaps chart']}],
        }) + '\n```'

    monkeypatch.setattr('app.services.tools.media_tools._vision_describe', fake_vision)
    verdict = await aj.judge_artifact(str(pdf), 'a one-page report with a chart', workspace=str(tmp_path))
    assert verdict['ok'] is True
    assert verdict['overall'] == 'fix'
    assert verdict['pages'][0]['issues'] == ['title overlaps chart']


@pytest.mark.asyncio
async def test_judge_unparseable_reply_is_honest(tmp_path, monkeypatch):
    pdf = _make_pdf(tmp_path / 'r2.pdf')

    async def fake_vision(image_path, question, url='', extra_images=None):
        return 'The page looks fine to me, great work!'

    monkeypatch.setattr('app.services.tools.media_tools._vision_describe', fake_vision)
    verdict = await aj.judge_artifact(str(pdf), 'anything', workspace=str(tmp_path))
    assert verdict['ok'] is False
    assert 'parseable' in verdict['error']
    assert 'fine' in verdict['raw']


@pytest.mark.asyncio
async def test_judge_requires_request(tmp_path):
    pdf = _make_pdf(tmp_path / 'r3.pdf')
    with pytest.raises(ValueError):
        await aj.judge_artifact(str(pdf), '', workspace=str(tmp_path))


def test_tools_registered():
    from app.services import tool_registry
    from app.services.tool_registrations import artifact_tools as art_reg

    art_reg.register()
    assert tool_registry.get('render_pages') is not None
    assert tool_registry.get('judge_artifact') is not None


# ── HTML/SVG artifacts — the half the judge could not see (Stage 3) ─────────
# `_DOC_EXT`/`_IMG_EXT`/`_PDF_EXT` had no `.html`, so a create_html_artifact
# figure fell through render_pages as "unsupported" and could never be judged.
# It now screenshots through the SHARED browser session from the Stage 1
# artifact route — the judge sees what the user's drawer sees. No engine
# starts here: the browser session is a stub that records the URL it was sent
# to (that URL is the assertion) and writes the PNG a screenshot would write.


class _FakeJudgePage:
    def __init__(self) -> None:
        self.urls: list[str] = []
        self.navBlockReason = None
        # Where the document actually is. A real page moves when a script
        # navigates it, and the judge has to notice — so the stub tracks it
        # rather than leaving `url` undefined.
        self.url = 'about:blank'

    async def goto(self, url: str, **_kw) -> None:
        self.urls.append(url)
        self.url = url

    async def navigate_self(self, url: str) -> None:
        """What `location = ...` in the judged document does to its own frame."""
        self.url = url

    async def wait_for_timeout(self, _ms: int) -> None:
        pass

    async def screenshot(self, path: str, **_kw) -> None:
        # Write where Playwright would write — the render-cache path the
        # judge hands us, not a path of the stub's own choosing.
        Image.new('RGB', (64, 48), 'white').save(path, 'PNG')


class _FakeJudgeSession:
    def __init__(self, page: _FakeJudgePage, sanctionedLoopbackOnly: bool = False) -> None:
        self.page = page
        self.navBlockReason = None
        # Set the way `getOrCreateSession` sets it, from the caller's flag.
        self.sanctionedLoopbackOnly = sanctionedLoopbackOnly


def _stub_browser(monkeypatch) -> tuple[_FakeJudgePage, dict]:
    from app.services.browser import session_manager as sm

    page = _FakeJudgePage()
    seen: dict = {}

    async def _fake_get_or_create(sid, **kw):
        seen['sid'] = sid
        seen.update(kw)
        return _FakeJudgeSession(page, sanctionedLoopbackOnly=bool(kw.get('allow_loopback')))

    monkeypatch.setattr(sm, 'getOrCreateSession', _fake_get_or_create)
    return page, seen


async def test_render_pages_live_html_uses_the_artifact_route(tmp_path, monkeypatch):
    from urllib.parse import parse_qs, unquote, urlparse

    src = tmp_path / 'figure.html'
    src.write_text('<!doctype html><html><body><script>spin()</script></body></html>', 'utf-8')
    page, seen = _stub_browser(monkeypatch)

    out = await aj.render_pages_live(str(src), workspace=str(tmp_path))
    assert out['ok'] is True, out
    assert out['renderer'] == 'browser(chromium)'
    assert out['pageCount'] == 1
    png = Path(out['rendered'][0])
    assert png.is_file() and png.stat().st_size > 100
    # The judge navigates the Stage 1 route — not file:// — so it screenshots
    # the same document, under the same CSP, the user's drawer serves.
    assert len(page.urls) == 1
    assert '/api/workbench/artifact/html' in page.urls[0]
    sent_path = parse_qs(urlparse(page.urls[0]).query)['path'][0]
    assert sent_path == str(src)
    # …through the shared engine with loopback permitted for the judge's own
    # session only.
    assert seen.get('allow_loopback') is True


async def test_a_document_that_navigates_away_is_never_screened(tmp_path, monkeypatch):
    """The judged document runs `script-src 'unsafe-inline'`, so between the
    goto and the capture it can move its own frame to another endpoint on the
    backend origin — and the screenshot would then show, and the vision model
    would then read, whatever THAT returns.

    The carve-out is a path, and the judge re-checks where the page actually
    ended up and discards the capture.
    """
    from app.services.browser import session_manager as sm

    src = tmp_path / 'hostile.html'
    src.write_text(
        '<!doctype html><html><body><script>'
        "setTimeout(()=>location='http://127.0.0.1:8085/api/providers',0)"
        '</script></body></html>',
        'utf-8',
    )

    page = _FakeJudgePage()

    async def _escape(_ms: int) -> None:
        page.url = 'http://127.0.0.1:8085/api/providers'

    page.wait_for_timeout = _escape  # type: ignore[method-assign]
    captured: list[str] = []
    page.screenshot = lambda **kw: captured.append(kw.get('path', ''))  # type: ignore[assignment]

    async def _fake_get_or_create(sid, **kw):
        return _FakeJudgeSession(page, sanctionedLoopbackOnly=bool(kw.get('allow_loopback')))

    monkeypatch.setattr(sm, 'getOrCreateSession', _fake_get_or_create)

    out = await aj.render_pages_live(str(src), workspace=str(tmp_path))
    assert out['ok'] is False, out
    assert 'blocked' in str(out.get('error', '')).lower(), out
    assert not captured, 'the judge screenshotted a page that had left the artifact route'


async def test_judge_html_reaches_the_vision_call(tmp_path, monkeypatch):
    src = tmp_path / 'explainer.html'
    src.write_text('<!doctype html><html><body><canvas></canvas><script>go()</script></body></html>', 'utf-8')
    _page, _seen = _stub_browser(monkeypatch)
    calls: list[str] = []

    async def fake_vision(image_path, question, url='', extra_images=None):
        calls.append(str(image_path))
        return '```json\n' + json.dumps({
            'overall': 'fix',
            'pages': [{'page': 1, 'pass': False, 'issues': ['needle never moves']}],
        }) + '\n```'

    monkeypatch.setattr('app.services.tools.media_tools._vision_describe', fake_vision)
    verdict = await aj.judge_artifact(str(src), 'an animated figure of a dial gauge', workspace=str(tmp_path))
    # The screenshot the browser path produced is the one the vision call saw.
    assert len(calls) == 1
    assert calls[0] in [str(p) for p in verdict['rendered']]
    assert verdict['ok'] is True
    assert verdict['overall'] == 'fix'
    assert verdict['pages'][0]['issues'] == ['needle never moves']


async def test_render_pages_live_pdf_stays_on_the_sync_renderer(tmp_path, monkeypatch):
    def _boom(*_a, **_kw):  # the browser must not be touched for a PDF
        raise AssertionError('browser session used for a non-HTML file')

    from app.services.browser import session_manager as sm
    monkeypatch.setattr(sm, 'getOrCreateSession', _boom)
    pdf = _make_pdf(tmp_path / 'deck2.pdf')
    out = await aj.render_pages_live(str(pdf), workspace=str(tmp_path))
    assert out['ok'] is True
    assert out['renderer'] == 'pypdfium2'


async def test_html_render_without_chromium_is_a_receipt_not_a_crash(tmp_path, monkeypatch):
    from app.services.browser import session_manager as sm
    monkeypatch.setattr(sm, '_findChromiumExecutable', lambda: '')
    src = tmp_path / 'figure2.html'
    src.write_text('<html><body>hi</body></html>', 'utf-8')
    out = await aj.render_pages_live(str(src), workspace=str(tmp_path))
    assert out['ok'] is False
    assert 'playwright install chromium' in out['error']


async def test_judge_html_without_chromium_returns_the_receipt(tmp_path, monkeypatch):
    from app.services.browser import session_manager as sm
    monkeypatch.setattr(sm, '_findChromiumExecutable', lambda: '')
    src = tmp_path / 'figure3.svg'
    src.write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf-8')
    verdict = await aj.judge_artifact(str(src), 'an svg figure', workspace=str(tmp_path))
    assert verdict['ok'] is False
    assert 'playwright install chromium' in verdict['error']

