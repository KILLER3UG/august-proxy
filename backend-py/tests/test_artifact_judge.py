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
