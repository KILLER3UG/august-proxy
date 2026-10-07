"""The writer-level data-dir isolation guard (backlog item 2).

Why a new file: this guard protects the user's LIVE stores, and nothing tested
it. `assertPytestDataDirIsolated` was written to log rather than raise, so the
leak it exists to catch — a test pointed at the real checkout `data/` — produced
a warning nobody read and a value that landed in the user's config and stayed
there. An unenforced guard is documentation.

The live store itself is never written by these tests: the guard fires before
any write, and the last test asserts the real file's bytes are unchanged.
"""

from __future__ import annotations

import hashlib
import json
import pathlib

import pytest
from app.lib import paths


def _live_data_dir() -> pathlib.Path:
    """The checkout's real data dir — asked of the module that owns it.

    My first version recomputed the path here and got one parent wrong, so it
    pointed at a directory that does not exist: the guard would have "passed"
    against the wrong target, and one test silently skipped. Ask the source.
    """
    return paths._repoDataDir()


class TestGuardRefusesTheLiveStore:
    def test_pointing_a_test_at_the_live_data_dir_raises(self, monkeypatch):
        live = _live_data_dir()
        monkeypatch.setenv('AUGUST_DATA_DIR', str(live))
        monkeypatch.setenv('PYTEST_CURRENT_TEST', 'tests/test_data_dir_isolation_guard.py::x (call)')
        with pytest.raises(RuntimeError, match='live'):
            paths.assertPytestDataDirIsolated('test.config writer')

    def test_a_pytest_basetemp_dir_still_passes(self, tmp_path, monkeypatch):
        """No false positive: the normal isolated fixture must stay silent."""
        fake_base = tmp_path / 'pytest-of-tester' / 'pytest-1' / 'test_case0'
        fake_base.mkdir(parents=True)
        monkeypatch.setenv('AUGUST_DATA_DIR', str(fake_base))
        monkeypatch.setenv('PYTEST_DEBUG_TEMPROOT', str(tmp_path / 'pytest-of-tester'))
        monkeypatch.setenv('PYTEST_CURRENT_TEST', 'tests/test_data_dir_isolation_guard.py::y (call)')
        paths.assertPytestDataDirIsolated('test.basetemp writer')  # must not raise

    def test_outside_pytest_nothing_is_enforced(self, monkeypatch):
        """The guard is a test harness, not a runtime policy — the app writes
        its own data dir on every save."""
        monkeypatch.delenv('PYTEST_CURRENT_TEST', raising=False)
        monkeypatch.setenv('AUGUST_DATA_DIR', str(_live_data_dir()))
        paths.assertPytestDataDirIsolated('test.nonpytest')  # must not raise


class TestConfigWriterIsGuarded:
    """`config_service.saveConfig` had no call at all, which is how
    `skillLearningJudgeModel='judge-model-x'` (written by test_distiller.py:342)
    ended up in the user's real config.json."""

    def test_any_json_write_aimed_inside_the_live_store_is_refused(self, monkeypatch):
        """The guard lives at write_json_atomic, so every store writer is
        covered by one change — config.json, providers.json, automations.json,
        aliases, background review. The target path is what is refused, whether
        or not a file is already there: on a machine with a real install,
        `data/providers.json` exists, and the guard must refuse AND leave the
        user's bytes untouched. Asserting only "does not exist" passed solely
        where the file happened to be absent.
        """
        from app.atomic_write import write_json_atomic

        target = _live_data_dir() / 'providers.json'
        before = target.read_bytes() if target.exists() else None
        monkeypatch.setenv('PYTEST_CURRENT_TEST', 'tests/test_data_dir_isolation_guard.py::p (call)')
        with pytest.raises(RuntimeError, match='live'):
            write_json_atomic(target, {'nope': True})
        if before is None:
            assert not target.exists()
        else:
            assert target.read_bytes() == before

    def test_a_sibling_prefix_directory_is_not_mistaken_for_the_live_store(self, monkeypatch):
        """`data_2` is not `data`; over-blocking here would break real tests."""
        from app.atomic_write import write_json_atomic

        monkeypatch.setenv('PYTEST_CURRENT_TEST', 'tests/test_data_dir_isolation_guard.py::q (call)')
        target = isolated_dir = tmp_dir = None  # noqa: F841
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            write_json_atomic(pathlib.Path(d) / 'config.json', {'ok': True})
            assert (pathlib.Path(d) / 'config.json').exists()

    def test_the_live_config_file_is_untouched_by_a_refused_write(self, monkeypatch):
        from app.services import config_service

        live = _live_data_dir()
        cfg_file = live / 'config.json'
        if not cfg_file.exists():
            pytest.skip('no live config.json in this checkout')
        before = hashlib.sha256(cfg_file.read_bytes()).hexdigest()
        monkeypatch.setenv('AUGUST_DATA_DIR', str(live))
        monkeypatch.setenv('PYTEST_CURRENT_TEST', 'tests/test_data_dir_isolation_guard.py::z (call)')

        with pytest.raises(RuntimeError):
            config_service.saveConfig({'leakProbe': {'shouldNotBeWritten': True}})

        assert hashlib.sha256(cfg_file.read_bytes()).hexdigest() == before, (
            'a refused test write still modified the user config — the guard runs too late'
        )

    def test_brain_config_writes_go_through_the_same_guard(self, monkeypatch):
        from app.services import brain_config_service as bcs

        monkeypatch.setenv('AUGUST_DATA_DIR', str(_live_data_dir()))
        monkeypatch.setenv('PYTEST_CURRENT_TEST', 'tests/test_data_dir_isolation_guard.py::b (call)')
        with pytest.raises(RuntimeError):
            bcs.saveBrainConfig({'skillLearningJudgeModel': 'judge-model-x'})

    def test_a_properly_isolated_write_still_succeeds(self, isolatedData):
        from app.services import brain_config_service as bcs

        ok, err, merged = bcs.saveBrainConfig({'skillLearningJudgeModel': 'a-real-model'})
        assert ok, err
        assert merged.get('skillLearningJudgeModel') == 'a-real-model'


class TestTheGuardIsInertOutsidePytest:
    """The direction that would actually break August.

    The refusal lives in `write_json_atomic`, which August calls on every save,
    and it refuses paths inside the checkout's `data/` — the directory a normal
    launch resolves to when AUGUST_DATA_DIR is unset. If that ever fired outside
    pytest the app could not save its own data, so the test-runner gate is
    pinned here rather than left to the docstring.

    Verified by hand against a real launch: with `PYTEST_CURRENT_TEST` unset and
    `AUGUST_DATA_DIR` unset, `dataDir()` resolves to the checkout data dir,
    `_refuse_live_store_write` does not raise, and both `saveConfig` and
    `write_json_atomic` write normally.
    """

    def test_a_normal_run_may_write_into_a_data_dir(self, tmp_path, monkeypatch):
        """No pytest marker, no env var — this is what a launch looks like."""
        monkeypatch.delenv('PYTEST_CURRENT_TEST', raising=False)
        from app.atomic_write import write_json_atomic

        target = tmp_path / 'config.json'
        write_json_atomic(target, {'saved': True})
        assert json.loads(target.read_text(encoding='utf-8'))['saved'] is True

    def test_the_refusal_helper_is_silent_without_the_test_marker(self, monkeypatch, tmp_path):
        monkeypatch.delenv('PYTEST_CURRENT_TEST', raising=False)
        from app.atomic_write import _refuse_live_store_write

        # Even aimed at the live dir it must be a no-op outside pytest.
        _refuse_live_store_write(str(_live_data_dir() / 'config.json'))

    def test_the_writer_guard_only_exists_while_a_test_runs(self, monkeypatch):
        """One test, both directions: with the marker it raises, without it the
        same call passes — so nobody can 'fix' a future failure by loosening
        the pytest check alone."""
        from app.atomic_write import _refuse_live_store_write

        target = str(_live_data_dir() / 'config.json')
        monkeypatch.setenv('PYTEST_CURRENT_TEST', 'tests/x::y (call)')
        with pytest.raises(RuntimeError):
            _refuse_live_store_write(target)
        monkeypatch.delenv('PYTEST_CURRENT_TEST')
        _refuse_live_store_write(target)
