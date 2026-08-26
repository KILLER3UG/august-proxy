"""Media guard + analyze_media tests.

read_file must REFUSE binary media (images/video/audio/documents) with a
redirect to analyze_media; text files keep reading normally.
analyze_media routes by file type: SVG returns source structure; unknown
types raise. Vision calls need a configured provider and are exercised
only for their absence path here (no network in tests).
"""

from __future__ import annotations

import asyncio

import pytest
from app.services.tool_registrations.file_tools import _readFile
from app.services.tools import media_tools


@pytest.fixture()
def media_dir(tmp_path):
    """A scratch dir with one file of each relevant class."""
    from PIL import Image

    png = tmp_path / 'shot.png'
    Image.new('RGB', (32, 32), (180, 40, 40)).save(png)
    mp3 = tmp_path / 'tone.mp3'
    mp3.write_bytes(b'ID3' + b'\x00' * 64)  # fake audio container
    svg = tmp_path / 'icon.svg'
    svg.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
        encoding='utf-8',
    )
    txt = tmp_path / 'notes.txt'
    txt.write_text('plain text', encoding='utf-8')
    return {'png': str(png), 'mp3': str(mp3), 'svg': str(svg), 'txt': str(txt)}


@pytest.mark.asyncio
async def test_read_file_refuses_images(media_dir):
    result = await _readFile(media_dir['png'])
    assert 'cannot be read as text' in result
    assert 'analyze_media' in result
    assert 'image' in result.lower()


@pytest.mark.asyncio
async def test_read_file_refuses_audio_with_kind(media_dir):
    result = await _readFile(media_dir['mp3'])
    assert 'audio' in result.lower()
    assert 'analyze_media' in result


@pytest.mark.asyncio
async def test_read_file_still_reads_text(media_dir):
    result = await _readFile(media_dir['txt'])
    assert 'plain text' in result


def test_media_kind_classification():
    from app.services.tool_registrations.file_tools import _media_kind

    assert _media_kind('.png') == 'image'
    assert _media_kind('.svg') == 'vector-image'
    assert _media_kind('.mp4') == 'video'
    assert _media_kind('.flac') == 'audio'
    assert _media_kind('.pdf') == 'document'


@pytest.mark.asyncio
async def test_analyze_media_svg_returns_structure(media_dir):
    # SVG is text — analyze_media surfaces its source structure.
    result = await media_tools.analyze_media(media_dir['svg'])
    assert result['kind'] == 'vector-image'
    assert '<svg' in result['structure']


@pytest.mark.asyncio
async def test_analyze_media_unknown_type_raises(tmp_path):
    weird = tmp_path / 'data.bin'
    weird.write_bytes(b'\x00\x01\x02')
    with pytest.raises(ValueError, match='Unsupported media type'):
        await media_tools.analyze_media(str(weird))


@pytest.mark.asyncio
async def test_analyze_media_requires_source():
    with pytest.raises(ValueError, match='path_or_url is required'):
        await media_tools.analyze_media('')


@pytest.mark.asyncio
async def test_analyze_media_missing_file(tmp_path):
    with pytest.raises(ValueError, match='File not found'):
        await media_tools.analyze_media(str(tmp_path / 'ghost.png'))
