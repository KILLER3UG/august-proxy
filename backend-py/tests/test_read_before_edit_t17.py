"""T17 read-before-edit gate: unit tests for
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
        assert 'modified since read' in err and 'Read it again' in err

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


class TestBulkWrites:
    def _report(self, label: str, paths: list[str], shas: list[str]) -> str:
        blocks = [f'===== {p} =====\n[sha256 {h}]\nbody' for p, h in zip(paths, shas)]
        return f'{label}: {len(paths)}/{len(paths)} succeeded.\n\n' + '\n\n'.join(blocks)

    def testBulkWriteUnseenFileRefused(self, tmp_path: Path) -> None:
        (tmp_path / 'a.txt').write_text('x')
        (tmp_path / 'new.txt').write_text('y')
        err = rbe.check_read_before_edit(
            _session(tmp_path),
            'write_files',
            {'files': [{'path': 'a.txt', 'content': '1'}, {'path': 'new.txt', 'content': '2'}]},
        )
        assert err is not None and rbe.UNSEEN_CODE in err and 'a.txt' in err

    def testBulkWriteCreationOnlyAllowed(self, tmp_path: Path) -> None:
        assert (
            rbe.check_read_before_edit(
                _session(tmp_path),
                'write_files',
                {'files': [{'path': 'brand-new.txt', 'content': '1'}]},
            )
            is None
        )

    def testBulkMetaToolWriteOpGated(self, tmp_path: Path) -> None:
        # The meta ``bulk`` tool with operation=write_files is gated the
        # same as the named write_files tool — otherwise the gate is a
        # one-word rename away from being bypassed.
        (tmp_path / 'a.txt').write_text('x')
        err = rbe.check_read_before_edit(
            _session(tmp_path),
            'bulk',
            {'operation': 'write_files', 'files': [{'path': 'a.txt', 'content': '1'}]},
        )
        assert err is not None and rbe.UNSEEN_CODE in err
        # A non-write bulk operation is not gated.
        assert (
            rbe.check_read_before_edit(_session(tmp_path), 'bulk', {'operation': 'fetch_urls', 'urls': ['x']})
            is None
        )

    def testBulkReadReportPinsVersions(self, tmp_path: Path) -> None:
        f = tmp_path / 'a.txt'
        f.write_text('v1')
        s = _session(tmp_path)
        rbe.observe_from_read_result(
            s, 'bulk', {'paths': ['a.txt']}, self._report('read_files', ['a.txt'], [_sha(f)])
        )
        assert rbe.check_read_before_edit(s, 'write_file', {'path': 'a.txt'}) is None

    def testBulkMutationChainsVersions(self, tmp_path: Path) -> None:
        f = tmp_path / 'a.txt'
        f.write_text('v1')
        s = _session(tmp_path)
        rbe.observe_from_read_result(
            s, 'bulk', {'paths': ['a.txt']}, self._report('read_files', ['a.txt'], [_sha(f)])
        )
        # August's own bulk write records the new bytes instead of forgetting
        # the observation → a follow-up write chains through.
        f.write_text('v2')
        rbe.observe_after_mutation(
            s, 'bulk', {'operation': 'write_files', 'files': [{'path': 'a.txt', 'content': 'v2'}]}
        )
        assert rbe.check_read_before_edit(s, 'write_file', {'path': 'a.txt'}) is None


class TestObservation:
    def testErrorReadResultNotObserved(self, tmp_path: Path) -> None:
        s = _session(tmp_path)
        rbe.observe_from_read_result(s, 'read_file', {'path': 'a.txt'}, 'Error: file not found')
        assert getattr(s, rbe._ATTR, {}) == {}

    def testMutationChainsSameFileEdits(self, tmp_path: Path) -> None:
        f = tmp_path / 'a.txt'
        f.write_text('v1')
        original = _sha(f)
        s = _session(tmp_path)
        rbe.observe_from_read_result(s, 'read_file', {'path': 'a.txt'}, f'[sha256 {original}]\nv1')
        assert rbe.check_read_before_edit(s, 'edit_lines', {'path': 'a.txt'}) is None
        # A successful mutation records August's own bytes: the follow-up
        # edit CHAINS (multi-editing in one turn) instead of being refused.
        f.write_text('v2')
        rbe.observe_after_mutation(s, 'write_file', {'path': 'a.txt'})
        assert rbe.check_read_before_edit(s, 'edit_lines', {'path': 'a.txt'}) is None
        # The stale hash the model still carries is normalized to the current
        # bytes so the tool's internal anchor check passes too.
        ti: dict[str, object] = {'path': 'a.txt', 'fileHash': original}
        assert rbe.check_read_before_edit(s, 'edit_lines', ti) is None
        assert ti['fileHash'] == _sha(f)
        # A FOREIGN change after August's write is still stale — chaining
        # only trusts bytes August itself produced.
        f.write_text('v3-external')
        err = rbe.check_read_before_edit(s, 'edit_lines', {'path': 'a.txt'})
        assert err is not None and rbe.STALE_CODE in err

    def testUnseenRefusalWording(self, tmp_path: Path) -> None:
        (tmp_path / 'a.txt').write_text('x')
        err = rbe.check_read_before_edit(_session(tmp_path), 'edit_lines', {'path': 'a.txt'})
        assert err is not None
        assert 'File has not been read yet' in err
        assert 'Read it first before writing to it' in err
        assert rbe.UNSEEN_CODE in err

    def testMapIsSessionScoped(self, tmp_path: Path) -> None:
        f = tmp_path / 'a.txt'
        f.write_text('v1')
        s1, s2 = _session(tmp_path), _session(tmp_path)
        rbe.observe_from_read_result(s1, 'read_file', {'path': 'a.txt'}, f'[sha256 {_sha(f)}]\nv1')
        assert rbe.check_read_before_edit(s1, 'write_file', {'path': 'a.txt'}) is None
        err = rbe.check_read_before_edit(s2, 'write_file', {'path': 'a.txt'})
        assert err is not None and rbe.UNSEEN_CODE in err
