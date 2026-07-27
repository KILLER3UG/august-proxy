"""search_files: rg exit-code handling + bounded, cancellable fallback."""

import asyncio

from app.services.tool_registrations import file_tools

# ── rg exit codes ──────────────────────────────────────────────────────


class _FakeProc:
    def __init__(self, returncode: int):
        self.returncode = returncode


def _patchRg(monkeypatch, returncode: int, stdout: bytes = b''):
    async def _fakeExec(*args, **kwargs):
        return _FakeProc(returncode)

    async def _fakeCommunicate(proc, timeout=None):
        return (stdout, b'')

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fakeExec)
    monkeypatch.setattr('app.lib.async_subprocess.communicate_or_kill', _fakeCommunicate)


async def test_rg_no_matches_exit_1_returns_fast_no_matches(monkeypatch, tmp_path):
    """Exit code 1 means 'no matches' — must NOT fall into the slow fallback."""
    _patchRg(monkeypatch, 1)
    result = await file_tools._searchFiles('anything', str(tmp_path))
    assert result == 'No matches found.'


async def test_rg_exit_0_returns_capped_results(monkeypatch, tmp_path):
    lines = '\n'.join(f'file.py:{i}:match {i}' for i in range(150))
    _patchRg(monkeypatch, 0, stdout=lines.encode())
    result = await file_tools._searchFiles('match', str(tmp_path))
    assert '... and 50 more results' in result
    assert result.count('match') <= 101 + 1  # 100 results + the suffix line


async def test_rg_error_exit_2_falls_back(monkeypatch, tmp_path):
    (tmp_path / 'a.txt').write_text('hello world', encoding='utf-8')
    _patchRg(monkeypatch, 2)
    result = await file_tools._searchFiles('hello', str(tmp_path))
    assert 'a.txt:1' in result


# ── fallback bounds ────────────────────────────────────────────────────


async def test_fallback_skips_vcs_and_dependency_dirs(tmp_path):
    (tmp_path / 'node_modules').mkdir()
    (tmp_path / 'node_modules' / 'dep.js').write_text('needle here', encoding='utf-8')
    (tmp_path / '.git').mkdir()
    (tmp_path / '.git' / 'blob').write_text('needle here', encoding='utf-8')
    (tmp_path / 'src').mkdir()
    (tmp_path / 'src' / 'app.py').write_text('needle here', encoding='utf-8')

    result = await file_tools._pySearchFiles('needle', tmp_path)

    assert 'src/app.py' in result.replace('\\', '/')
    assert 'node_modules' not in result
    assert '.git' not in result


async def test_fallback_honors_cancel_event(tmp_path):
    (tmp_path / 'a.txt').write_text('needle', encoding='utf-8')

    class _Set:
        def is_set(self):
            return True

    result = file_tools._pySearchFilesSync('needle', tmp_path, _Set())
    assert result == 'Search cancelled.'


async def test_fallback_hard_timeout(monkeypatch, tmp_path):
    """A stuck walk must surface a timeout error, never hang the turn."""
    monkeypatch.setattr(file_tools, '_SEARCH_FALLBACK_TIMEOUT_S', 0.2)

    def _stuck(query, searchPath, cancelEvent=None):
        import time

        time.sleep(2)
        return 'never'

    monkeypatch.setattr(file_tools, '_pySearchFilesSync', _stuck)

    result = await file_tools._pySearchFiles('x', tmp_path)
    assert 'timed out' in result
