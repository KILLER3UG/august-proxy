"""World-delta stall evidence (audit D4).

The stall counter used to trust only self-reports (``update_state`` phase/step
and argument novelty). These pin the world-delta path: a turn that touches a
path it had not touched before, or clears a (tool, target) that was failing
with a known error family, is credited with progress even when both
self-reports are flat.
"""

from __future__ import annotations

from app.services.workbench.workbench import _recordWorldDelta


def test_new_path_is_world_delta():
    paths: set[str] = set()
    families: dict[tuple[str, str], str] = {}
    assert _recordWorldDelta(
        'read_file', {'path': 'src/main.py'}, 'print(1)', world_paths=paths, family_by_target=families
    )
    # Same path again is NOT new movement.
    assert not _recordWorldDelta(
        'read_file', {'path': 'src/main.py'}, 'print(1)', world_paths=paths, family_by_target=families
    )
    # A different path is.
    assert _recordWorldDelta(
        'read_file', {'path': 'src/other.py'}, 'x', world_paths=paths, family_by_target=families
    )


def test_error_family_cleared_on_same_target_is_delta():
    paths: set[str] = set()
    families: dict[tuple[str, str], str] = {}
    target_args = {'command': 'pytest -q tests/x.py'}
    # First run fails with a family the rules recognize.
    assert not _recordWorldDelta(
        'run_command',
        target_args,
        'pytest failed\nexit code: 1',
        world_paths=paths,
        family_by_target=families,
    )
    assert families[('run_command', "pytest -q tests/x.py")] == 'process_exit'
    # Retry on the SAME target now returns clean — the shell told the truth.
    assert _recordWorldDelta(
        'run_command',
        target_args,
        '12 passed',
        world_paths=paths,
        family_by_target=families,
    )
    assert ('run_command', "pytest -q tests/x.py") not in families


def test_clean_result_without_prior_family_is_not_delta():
    paths: set[str] = set()
    families: dict[tuple[str, str], str] = {}
    assert not _recordWorldDelta(
        'run_command',
        {'command': 'echo hi'},
        'hi',
        world_paths=paths,
        family_by_target=families,
    )


def test_error_result_does_not_clear_a_family():
    paths: set[str] = set()
    families: dict[tuple[str, str], str] = {}
    args = {'command': 'pytest -q tests/x.py'}
    _recordWorldDelta('run_command', args, 'boom\nexit code: 1', world_paths=paths, family_by_target=families)
    # A different FAILURE (still an Error result) must not count as progress.
    assert not _recordWorldDelta(
        'run_command', args, 'Error: connection refused', world_paths=paths, family_by_target=families
    )


def test_non_string_result_only_counts_paths():
    paths: set[str] = set()
    families: dict[tuple[str, str], str] = {}
    assert _recordWorldDelta(
        'read_files', {'paths': ['a.py', 'b.py']}, {'ok': True}, world_paths=paths, family_by_target=families
    )
    assert paths == {'a.py', 'b.py'}
