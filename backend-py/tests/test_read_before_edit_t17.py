"""T17 read-before-edit gate (plan §9.4): unit tests for
app/services/workbench/read_before_edit.py. Loop-level wiring lives in
test_workbench_tool_loop.py (TestReadBeforeEditInLoop)."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.workbench import read_before_edit as rbe  # noqa: E402


def _session(workspace: Path) -> SimpleNamespace:
    return SimpleNamespace(workspacePath=str(workspace))


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


class TestCheckReadBeforeEdit:
    def testNonGatedToolPasses(self, tmp_path: Path) -> None:
        (tmp_path / 'a.txt').write_text('x')
        assert rbe.check_read_before_edit(_session(tmp_path), 'read_file', {'path': 'a.txt'}) is None

    def testCreationAllowed(self, tmp_path: Path) -> None:
        assert rbe.check_read_before_edit(_session(tmp_path), 'write_file', {'path': 'new.txt'}) is None

    def testUnseenFileRejected(self, tmp_path: Path) -> None:
        (tmp_path / 'a.txt').write_text('original')
        err = rbe.check_read_before_edit(_session(tmp_path), 'write_file', {'path': 'a.txt'})
        assert err is not None
        assert rbe.UNSEEN_CODE in err
        assert 'read_file' in err and 'retry' in err

    def testObservedUnchangedPasses(self, tmp_path: Path) -> None:
        f = tmp_path / 'a.txt'
        f.write_text('original')
        s = _session(tmp_path)
        readResult = f'[sha256 {_sha(f)}]\noriginal'
        rbe.observe_from_read_result(s, 'read_file', {'path': 'a.txt'}, readResult)
        assert rbe.check_read_before_edit(s, 'edit_lines', {'path': 'a.txt'}) is None

    def testStaleVersionRejected(self, tmp_path: Path) -> None:
        f = tmp_path / 'a.txt'
        f.write_text('original')
        s = _session(tmp_path)
        rbe.observe_from_read_result(s, 'read_file', {'path': 'a.txt'}, f'[sha256 {_sha(f)}]\noriginal')
        f.write_text('changed behind the model\'s back')
        err = rbe.check_read_before_edit(s, 'apply_patch', {'path': 'a.txt'})
        assert err is not None
        assert rbe.STALE_CODE in err
        assert 'Re-read' in err

    def testRelativePathResolvedAgainstWorkspace(self, tmp_path: Path) -> None:
        f = tmp_path / 'sub' / 'a.txt'
        f.parent.mkdir()
        f.write_text('v1')
        s = _session(tmp_path)
        err = rbe.check_read_before_edit(s, 'write_file', {'path': 'sub/a.txt'})
        assert err is not None and rbe.UNSEEN_CODE in err
        rbe.observe_from_read_result(s, 'read_file', {'path': str(f)}, f'[sha256 {_sha(f)}]\nv1')
        assert rbe.check_read_before_edit(s, 'write_file', {'path': 'sub/a.txt'}) is None

    def testMissingPathInputPasses(self, tmp_path: Path) -> None:
        assert rbe.check_read_before_edit(_session(tmp_path), 'write_file', {}) is None


class TestObservation:
    def testErrorReadResultNotObserved(self, tmp_path: Path) -> None:
        s = _session(tmp_path)
        rbe.observe_from_read_result(s, 'read_file', {'path': 'a.txt'}, 'Error: file not found')
        assert getattr(s, rbe._ATTR, {}) == {}

    def testMutationObservationUnblocksFollowUp(self, tmp_path: Path) -> None:
        f = tmp_path / 'a.txt'
        f.write_text('v1')
        s = _session(tmp_path)
        # Unseen → blocked.
        assert rbe.check_read_before_edit(s, 'write_file', {'path': 'a.txt'}) is not None
        # Simulate an out-of-band successful write (e.g. gate disabled once,
        # or the tool itself created the file): recording the new version
        # unblocks follow-up edits without another read.
        f.write_text('v2')
        rbe.observe_after_mutation(s, 'write_file', {'path': 'a.txt'})
        assert rbe.check_read_before_edit(s, 'edit_lines', {'path': 'a.txt'}) is None
        # External change after the mutation → stale again.
        f.write_text('v3')
        err = rbe.check_read_before_edit(s, 'edit_lines', {'path': 'a.txt'})
        assert err is not None and rbe.STALE_CODE in err

    def testMapIsSessionScoped(self, tmp_path: Path) -> None:
        f = tmp_path / 'a.txt'
        f.write_text('v1')
        s1, s2 = _session(tmp_path), _session(tmp_path)
        rbe.observe_from_read_result(s1, 'read_file', {'path': 'a.txt'}, f'[sha256 {_sha(f)}]\nv1')
        assert rbe.check_read_before_edit(s1, 'write_file', {'path': 'a.txt'}) is None
        err = rbe.check_read_before_edit(s2, 'write_file', {'path': 'a.txt'})
        assert err is not None and rbe.UNSEEN_CODE in err
