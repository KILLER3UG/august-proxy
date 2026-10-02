"""Regression tests for fixes that shipped without a test that could fail.

An adversarial review reverted each fix in a scratch copy and watched the suite
stay green — because the tests exercised a FUNCTION while the defect was a
missing CALL, or asserted that the new code did what the new code does. These
close that specific gap: each test here fails when the corresponding fix is
reverted.

1. The skill review read usage off the catalogue row (``list_all`` never
   returns it) and reported ``used=0 last=never`` for every skill — the evidence
   a judge acts on when proposing a ``skill_delete``.
2. Paged ``read_file`` hashed with a synchronous ``Path.read_bytes()`` on the
   event loop and materialised every line via ``splitlines``.
3. ``client.ts`` bound discovery to a `const`, so one slow boot poisoned every
   await forever. (Frontend; covered by src/api/__tests__/client.discovery.test.ts —
   this file holds the Python half.)
"""

from __future__ import annotations

import ast
import inspect
import pathlib
import sqlite3

import pytest

# --------------------------------------------------------------------------
# 1. skill review reports REAL usage
# --------------------------------------------------------------------------


class TestSkillReviewSeesRealUsage:
    def test_a_used_skill_is_not_reported_as_never_used(self, isolatedSkills):
        """The listing is what the review judge reads. A skill used five times
        and shown `used=0 last=never` biases it toward proposing a deletion."""
        from app.services import skill_service
        from app.services.memory_store import consolidation

        created = skill_service.createSkill('used-skill', 'd', 'body')
        path = str(created.get('path') or '')
        assert path, 'createSkill returned no path to count a use against'
        for _ in range(5):
            skill_service.record_skill_use(path)

        entries = consolidation._skill_catalogue()  # noqa: SLF001 -- the seam under test
        row = next(e for e in entries if e['name'] == 'used-skill')
        assert row['usageCount'] == 5, f'usage reported as {row["usageCount"]}'
        assert row['lastUsed'], 'lastUsed was empty for a skill that was used'

        listing = consolidation._skill_catalogue_listing(entries)  # noqa: SLF001
        assert 'used=5' in listing, listing
        assert "last=never" not in listing.split('used-skill')[1].split('\n')[0]

    def test_an_unused_skill_reports_zero(self, isolatedSkills):
        from app.services import skill_service
        from app.services.memory_store import consolidation

        assert skill_service.createSkill('idle-skill', 'd', 'body')
        entries = consolidation._skill_catalogue()  # noqa: SLF001
        row = next(e for e in entries if e['name'] == 'idle-skill')
        assert row['usageCount'] == 0

    def test_the_reading_is_the_documented_one(self):
        """Pin the accessor so a future 'read it off the row again' change fails."""
        from app.services.memory_store import consolidation

        src = inspect.getsource(consolidation._skill_catalogue)  # noqa: SLF001
        assert 'read_skill_usage' in src, (
            'the review pass stopped using skill_service.read_skill_usage — '
            "that accessor is the only one that reads the sidecar"
        )


# --------------------------------------------------------------------------
# 2. paged read_file does not block the loop or materialise the file
# --------------------------------------------------------------------------


def test_read_file_does_not_use_a_synchronous_whole_file_read():
    """`Path.read_bytes()` inside `async def` froze the event loop for up to
    `_MAXPageFileSize` (200 MB) — and every concurrent SSE stream with it."""
    from app.services.tool_registrations.file_tools import _readFile

    tree = ast.parse(inspect.getsource(_readFile))
    called = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    # Walk the AST, not the text: the docstring deliberately explains WHY the
    # raw bytes are hashed and mentions read_bytes() while doing it in chunks.
    assert 'read_bytes' not in called, (
        '_readFile calls Path.read_bytes() synchronously on the event loop'
    )
    assert 'splitlines' not in called, (
        '_readFile materialises every line of the file to return the paging window'
    )


async def test_the_hash_is_still_the_raw_bytes(tmp_path):
    """Guards against over-correcting: the hash must stay the RAW bytes, since
    text decoding normalizes CRLF and would mismatch the edit gate."""
    import hashlib

    from app.services.tool_registrations.file_tools import _readFile

    f = tmp_path / 'crlf.txt'
    f.write_bytes(b'a\r\nb\r\n\xff')
    out = await _readFile(str(f))
    assert f'[sha256 {hashlib.sha256(b"a\r\nb\r\n\xff").hexdigest()}]' in out


async def test_a_large_paged_read_returns_the_window(tmp_path):
    from app.services.tool_registrations.file_tools import _readFile

    f = tmp_path / 'big.txt'
    f.write_text('\n'.join(f'line {i}' for i in range(1, 5001)), encoding='utf-8')
    out = await _readFile(str(f), offset=100, limit=3)
    assert '[lines 100-102 of 5000]' in out
    assert 'line 100' in out and 'line 102' in out
    assert 'line 103' not in out


def test_the_checkpoint_actually_exists_and_is_configurable():
    from app.services.memory_conn import _CHECKPOINT_EVERY_N_WRITES, note_commit

    assert callable(note_commit)
    assert _CHECKPOINT_EVERY_N_WRITES >= 1


# --------------------------------------------------------------------------
# 3. the SwiftRule: the readiness promise must be recoverable
# --------------------------------------------------------------------------


class TestFrontendDiscoveryIsResettable:
    """The frontend half, asserted from here so the backend suite carries the
    contract too: `client.ts` must export a reset and must NOT cache a
    rejection forever."""

    CLIENT = (
        pathlib.Path(__file__).resolve().parents[2]
        / 'frontend'
        / 'desktop'
        / 'src'
        / 'api'
        / 'client.ts'
    )

    def _src(self) -> str:
        assert self.CLIENT.exists(), f'missing {self.CLIENT}'
        return self.CLIENT.read_text('utf-8')

    def test_the_promise_is_mutable_and_reset_exported(self):
        src = self._src()
        assert 'export function resetDiscovery' in src, (
            'client.ts has no resetDiscovery — a failed discovery cannot be '
            'retried, so every await ready() fails for the life of the window'
        )
        assert 'readyPromise = null' in src, 'the failed discovery is cached'

    def test_a_rejection_is_not_cached(self):
        src = self._src()
        assert '.catch(' in src and 'readyPromise = null' in src, (
            'a rejected discovery must be discarded so the next caller retries'
        )

# --------------------------------------------------------------------------
# 4. paged reads stream, and stay byte-exact
# --------------------------------------------------------------------------


class TestPagedReadIsStreamingAndExact:
    """The paged branch used to decode the WHOLE file — up to 200 MB — in order
    to return `limit` lines. It now streams: count lines, keep only the window.

    These tests pin the two properties that make that safe, both of which were
    broken by a first attempt that a 3000-case fuzz caught:

    1. the line NUMBERS must match `splitlines`, including the exotic
       separators, because the model addresses edits by those numbers;
    2. the line TEXT must be byte-exact, including CRLF, because `edit_lines`
       matches its `old` anchor against verbatim file content.
    """

    async def test_a_page_reports_the_true_total(self, tmp_path):
        import asyncio

        from app.services.tool_registrations.file_tools import _readFile

        f = tmp_path / 'many.txt'
        f.write_text('\n'.join(f'line {i}' for i in range(1, 5001)), encoding='utf-8')
        out = await _readFile(str(f), offset=100, limit=3)
        assert '[lines 100-102 of 5000]' in out, out[:120]
        assert 'line 100' in out and 'line 102' in out
        assert 'line 103' not in out

    async def test_exotic_separators_still_count_as_line_breaks(self, tmp_path):
        import ast

        from app.services.tool_registrations.file_tools import _readFile

        # \v, \f, \x1c and U+2028 all break lines for str.splitlines.
        text = ('a\vb\fc\x1cd e' * 50)
        f = tmp_path / 'exotic.txt'
        f.write_text(text, encoding='utf-8')
        total = len(text.splitlines(keepends=True))
        out = await _readFile(str(f), offset=1, limit=2)
        assert f'of {total}]' in out, (
            f'streaming split only broke on newlines: expected a total of {total}, '
            f'got {out[:120]!r}'
        )

    async def test_crlf_lines_come_back_byte_exact(self, tmp_path):
        """A CRLF file must not be normalized. The model pastes these lines into
        `edit_lines`' `old` anchor, which is matched against verbatim file text,
        so an LF here makes every CRLF edit silently fail to apply."""
        import hashlib

        from app.services.tool_registrations.file_tools import _readFile

        raw = b'alpha\r\nbeta\r\ngamma\r\n'
        f = tmp_path / 'crlf.txt'
        f.write_bytes(raw)
        out = await _readFile(str(f), offset=1, limit=2)
        assert f'[sha256 {hashlib.sha256(raw).hexdigest()}]' in out
        assert 'alpha\r\n' in out, repr(out)
        assert 'beta\r\n' in out
        assert 'alpha\n\n' not in out

    async def test_a_trailing_partial_line_is_still_counted(self, tmp_path):
        from app.services.tool_registrations.file_tools import _readFile

        f = tmp_path / 'no-newline.txt'
        f.write_text('a\nb\nc', encoding='utf-8')  # no trailing newline
        out = await _readFile(str(f), offset=3, limit=1)
        assert '[lines 3-3 of 3]' in out, out[:120]
        assert '| c' in out

    async def test_starting_past_the_end_is_explicit(self, tmp_path):
        from app.services.tool_registrations.file_tools import _readFile

        f = tmp_path / 'short.txt'
        f.write_text('a\nb\n', encoding='utf-8')
        out = await _readFile(str(f), offset=99)
        assert 'no line 99' in out
        assert '2 line(s)' in out

    async def test_a_large_file_does_not_arrive_whole(self, tmp_path):
        """The point of the change: peak memory is the window, not the file.

        Written as a size assertion on the RETURNED text rather than on RSS,
        because the return is the thing we control and RSS is not observable
        from a unit test.
        """
        from app.services.tool_registrations.file_tools import _readFile

        f = tmp_path / 'big.txt'
        lines = 50_000
        width = 4_000
        with f.open('w', encoding='utf-8') as fh:
            for _ in range(lines):
                fh.write('x' * width)
                fh.write('\n')
        size = f.stat().st_size
        assert size > 20 * 1024 * 1024, f'fixture too small to prove anything: {size}'
        out = await _readFile(str(f), offset=1, limit=2)
        assert len(out) < 20_000, f'read returned {len(out)} bytes for a 2-line page'
        assert f'[lines 1-2 of {lines}]' in out
