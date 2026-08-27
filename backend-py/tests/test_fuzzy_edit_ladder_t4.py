"""T4 fuzzy edit fallback ladder (plan §9.4): exact → leading-whitespace →
blank-line/elided block → nearby drift, before rejecting. Hash anchors stay
the staleness gate; the ladder is about match tolerance."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.tool_registrations import file_tools as ft  # noqa: E402


class TestResolveAnchor:
    LINES = ['def foo():', '    x = 1', '', '    return x']

    def testExact(self) -> None:
        assert ft._resolveAnchor(self.LINES, 1, '    x = 1') == (1, 2, 'exact')

    def testLeadingWhitespace(self) -> None:
        assert ft._resolveAnchor(self.LINES, 1, 'x = 1') == (1, 2, 'leading-ws')

    def testTrailingWhitespace(self) -> None:
        assert ft._resolveAnchor(self.LINES, 1, '    x = 1   ') == (1, 2, 'ws')

    def testDriftNearby(self) -> None:
        lines = ['# moved', 'def foo():', '    x = 1']
        # Model points at line 1 (idx 0) but the anchor sits one line lower.
        got = ft._resolveAnchor(lines, 0, 'def foo():')
        assert got == (1, 2, 'drift')

    def testDriftTooFarRejected(self) -> None:
        lines = ['a', 'b', 'c', 'd', 'e', 'target']
        assert ft._resolveAnchor(lines, 0, 'target') is None

    def testBlockExact(self) -> None:
        old = '    x = 1\n\n    return x'
        assert ft._resolveAnchor(self.LINES, 1, old) == (1, 4, 'block')

    def testBlockBlankTolerant(self) -> None:
        # File gained an extra blank line between the anchors.
        lines = ['def foo():', '    x = 1', '', '', '    return x']
        old = '    x = 1\n\n    return x'
        assert ft._resolveAnchor(lines, 1, old) == (1, 5, 'block')

    def testBlockElidedLines(self) -> None:
        lines = ['def foo():', '    x = 1', '    y = 2', '    z = 3', '    return x']
        old = '    x = 1\n    ...\n    return x'
        got = ft._resolveAnchor(lines, 1, old)
        assert got == (1, 5, 'block')

    def testBlockWsTolerant(self) -> None:
        lines = ['def foo():', '  x = 1', '    return x']
        old = '    x = 1\n    return x'
        got = ft._resolveAnchor(lines, 1, old)
        assert got is not None
        assert got[2] == 'block-fuzzy'

    def testNoMatchAtAll(self) -> None:
        assert ft._resolveAnchor(self.LINES, 1, 'something else entirely') is None


class TestEditLinesLadder:
    """End-to-end through _editLines: hash gate stays, ladder applied."""

    def _write(self, tmp_path: Path, text: str) -> tuple[Path, str]:
        f = tmp_path / 'mod.py'
        f.write_bytes(text.encode('utf-8'))
        return f, hashlib.sha256(f.read_bytes()).hexdigest()

    @pytest.mark.asyncio
    async def testExactEditUnchanged(self, tmp_path: Path) -> None:
        f, h = self._write(tmp_path, 'def foo():\n    x = 1\n    return x\n')
        result = await ft._editLines(
            str(f), h, [{'line': 2, 'old': '    x = 1', 'new': '    x = 2'}]
        )
        assert result == f'Applied 1 edit to {f}.'
        assert 'x = 2' in f.read_text()

    @pytest.mark.asyncio
    async def testLeadingWsFuzzy(self, tmp_path: Path) -> None:
        f, h = self._write(tmp_path, 'def foo():\n    x = 1\n    return x\n')
        result = await ft._editLines(str(f), h, [{'line': 2, 'old': 'x = 1', 'new': '    x = 2'}])
        assert 'Applied 1 edit' in result
        assert 'leading-ws' in result
        assert f.read_text() == 'def foo():\n    x = 2\n    return x\n'

    @pytest.mark.asyncio
    async def testDriftFuzzy(self, tmp_path: Path) -> None:
        f, h = self._write(tmp_path, '# header\n# header2\ndef foo():\n    x = 1\n')
        # Model thinks the anchor is on line 1; it is actually on line 3.
        result = await ft._editLines(
            str(f), h, [{'line': 1, 'old': 'def foo():', 'new': 'def bar():'}]
        )
        assert 'drift' in result
        assert 'def bar():' in f.read_text()

    @pytest.mark.asyncio
    async def testBlockWithElision(self, tmp_path: Path) -> None:
        src = 'def foo():\n    a = 1\n    b = 2\n    c = 3\n    return a\n'
        f, h = self._write(tmp_path, src)
        old = '    a = 1\n    ...\n    return a'
        new = '    return 42'
        result = await ft._editLines(str(f), h, [{'line': 2, 'old': old, 'new': new}])
        assert 'block' in result
        assert f.read_text() == 'def foo():\n    return 42\n'

    @pytest.mark.asyncio
    async def testDeleteLineWithEmptyNew(self, tmp_path: Path) -> None:
        f, h = self._write(tmp_path, 'a\nb\nc\n')
        result = await ft._editLines(str(f), h, [{'line': 2, 'old': 'b', 'new': ''}])
        assert 'Applied 1 edit' in result
        assert f.read_text() == 'a\nc\n'

    @pytest.mark.asyncio
    async def testTrueMismatchStillRejects(self, tmp_path: Path) -> None:
        f, h = self._write(tmp_path, 'alpha\nbeta\ngamma\n')
        result = await ft._editLines(str(f), h, [{'line': 2, 'old': 'zeta', 'new': 'x'}])
        assert result.startswith('Error: anchor mismatch')
        assert f.read_text() == 'alpha\nbeta\ngamma\n'

    @pytest.mark.asyncio
    async def testStaleHashStillRejects(self, tmp_path: Path) -> None:
        f, _ = self._write(tmp_path, 'alpha\n')
        result = await ft._editLines(str(f), 'deadbeef', [{'line': 1, 'old': 'alpha', 'new': 'b'}])
        assert 'hash mismatch' in result
