"""`exam.py` must not let the request define its own containment root (triage #23).

A caller-supplied `workspacePath` used to BE the root, and the only check was
`p.relative_to(ws_root)` — so `{"workspacePath": "/"}` satisfied containment for
every absolute path on the machine and the first 10 KB of each was read into the
exam prompt. The comment above the call already claimed "arbitrary absolute
paths are rejected"; that held only for the no-workspace branch.

The read loop was inline in the request handler, so this was only reachable
through the whole request/DB path. It is now `_read_attached_files`, and these
tests drive that directly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def secret(tmp_path, monkeypatch):
    """A file genuinely OUTSIDE the temp root, hermetically and on any platform.

    Not `tmp_path`: pytest places `tmp_path` UNDER `tempfile.gettempdir()`, so a
    secret put there is legitimately readable by the no-workspace branch and the
    test fails for the wrong reason — it asserts a bug that is not there.

    The temp root is therefore REDIRECTED into tmp_path/inside, and the secret
    goes to tmp_path/outside. That makes "outside the temp dir" exact on every
    platform. The first version used `Path(gettempdir()).parent`, which is
    `C:\\Users\\<u>\\AppData\\Local` on Windows and `/` on Linux — so it passed
    locally and died in CI with PermissionError creating `/august_exam_probe`.
    A green local run is not evidence the test is portable.
    """
    import tempfile

    inside = tmp_path / 'inside'
    outside = tmp_path / 'outside'
    inside.mkdir()
    outside.mkdir()
    monkeypatch.setattr(tempfile, 'gettempdir', lambda: str(inside))

    p = outside / 'secret.txt'
    p.write_text('SUPER_SECRET_MARKER contents', encoding='utf-8')
    return p


@pytest.fixture
def workspaceFile(tmp_path):
    ws = tmp_path / 'proj'
    ws.mkdir()
    f = ws / 'notes.md'
    f.write_text('PROJECT_MARKER notes', encoding='utf-8')
    return ws, f


class TestContainmentRootIsNotAssertable:
    def test_a_slash_workspace_is_not_accepted_as_a_root(self):
        """The core hole. `/` is a directory, so the old code took it."""
        from app.routers.exam import _trusted_workspace_root

        assert _trusted_workspace_root('', '/') is None, (
            'a request-supplied root of "/" was accepted — every absolute path '
            'would then satisfy relative_to()'
        )

    def test_an_unowned_workspace_is_refused(self, secret):
        from app.routers.exam import _trusted_workspace_root

        assert _trusted_workspace_root('', str(secret.parent)) is None, (
            'a workspace nobody owns was accepted as a containment root'
        )

    def test_a_mismatched_claim_is_refused_even_with_a_session(self, tmp_path, monkeypatch):
        """The session's workspace is the ceiling, not a suggestion."""
        from app.routers.exam import _trusted_workspace_root

        owned = tmp_path / 'mine'
        owned.mkdir()
        other = tmp_path / 'theirs'
        other.mkdir()

        class _Wb:
            workspacePath = str(owned)

        monkeypatch.setattr(
            'app.services.workbench.sessions.get_workbench_session', lambda sid: _Wb()
        )
        assert _trusted_workspace_root('sess-1', str(other)) is None

    def test_a_session_owned_workspace_is_still_honoured(self, workspaceFile, monkeypatch):
        """The fix must not make the workspace branch dead code."""
        from app.routers.exam import _trusted_workspace_root

        ws, _f = workspaceFile

        class _Wb:
            workspacePath = str(ws)

        monkeypatch.setattr(
            'app.services.workbench.sessions.get_workbench_session', lambda sid: _Wb()
        )
        root = _trusted_workspace_root('sess-1', str(ws))
        assert root is not None, 'a workspace the session genuinely owns was rejected'
        assert Path(root).resolve() == ws.resolve()


class TestAttachedFileReads:
    def test_no_workspace_means_temp_dir_only(self, secret):
        from app.routers.exam import _read_attached_files

        out = _read_attached_files([str(secret)], None)
        assert 'SUPER_SECRET_MARKER' not in out, (
            'a file outside the temp dir was read with no workspace at all'
        )

    def test_a_session_root_reads_its_own_files(self, workspaceFile):
        from app.routers.exam import _read_attached_files

        ws, f = workspaceFile
        assert 'PROJECT_MARKER' in _read_attached_files([str(f)], ws)

    def test_a_session_root_does_not_read_outside_itself(self, workspaceFile, secret):
        from app.routers.exam import _read_attached_files

        ws, _f = workspaceFile
        out = _read_attached_files([str(secret)], ws)
        assert 'SUPER_SECRET_MARKER' not in out, (
            'a file outside the session workspace was read anyway'
        )

    def test_a_traversal_out_of_the_root_is_refused(self, workspaceFile, secret):
        """`..` must not walk out of a root the path otherwise passed."""
        from app.routers.exam import _read_attached_files

        ws, _f = workspaceFile
        sneaky = str(Path(ws) / '..' / secret.parent.name / secret.name)
        out = _read_attached_files([sneaky], ws)
        assert 'SUPER_SECRET_MARKER' not in out

    def test_a_symlink_out_of_the_root_is_refused(self, workspaceFile, secret, tmp_path):
        """The candidate is resolved before the containment check, so this holds."""
        from app.routers.exam import _read_attached_files

        ws, _f = workspaceFile
        link = ws / 'innocent.md'
        try:
            link.symlink_to(secret)
        except (OSError, NotImplementedError):
            pytest.skip('symlinks unavailable on this platform')
        out = _read_attached_files([str(link)], ws)
        assert 'SUPER_SECRET_MARKER' not in out, (
            'a symlink inside the workspace escaped to a target outside it'
        )

    def test_the_context_stays_bounded(self, tmp_path):
        """10 KB cap, so a huge attachment cannot crowd out the prompt."""
        import tempfile

        from app.routers.exam import _read_attached_files

        big = Path(tempfile.gettempdir()) / 'exam_big_probe.txt'
        big.write_text('X' * 50_000, encoding='utf-8')
        try:
            out = _read_attached_files([str(big)], None)
        finally:
            big.unlink(missing_ok=True)
        assert len(out) <= 10_000
        assert out, 'the bounded read returned nothing at all'

    def test_the_endpoint_shape_is_unchanged(self, workspaceFile):
        """`sourceFiles` still serialises the request's file list verbatim."""
        ws, f = workspaceFile
        assert json.loads(json.dumps([str(f)])) == [str(f)]