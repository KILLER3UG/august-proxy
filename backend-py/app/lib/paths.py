"""
Resolve data directory paths. Respects AUGUST_DATA_DIR env var.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


def dataDir() -> Path:
    override = os.environ.get('AUGUST_DATA_DIR')
    if override:
        return Path(override)
    # Part 27 E2: pytest runs MUST be isolated (tests/conftest.py sets
    # AUGUST_DATA_DIR autouse). Reaching the live checkout data dir from a
    # test means the isolation fixture was bypassed — the July/August leaks
    # (MagicMock agent_jobs, fixture plans, s1/fp1 episodes) all entered the
    # user's stores exactly this way. Fail loudly instead of writing junk.
    if os.environ.get('PYTEST_CURRENT_TEST'):
        raise RuntimeError(
            'pytest run without AUGUST_DATA_DIR isolation — refusing to touch '
            'the live data dir (see tests/conftest.py isolatedData)'
        )
    return Path(__file__).resolve().parent.parent.parent.parent / 'data'


def dataPath(*parts: str) -> Path:
    return dataDir().joinpath(*parts)


def _isUnderPytestBasetemp(path: Path) -> bool:
    """True when ``path`` lives under pytest's per-test ``tmp_path`` (the
    *real* isolation target — ``AUGUST_DATA_DIR`` should be that tmp dir).
    Used by writer-level guards to surface tests that bypass the autouse
    fixture: even if a test set ``AUGUST_DATA_DIR`` to *something*, this
    catches the case where that something is the user's real checkout."""
    basetemp = os.environ.get('PYTEST_DEBUG_TEMPROOT') or os.environ.get(
        'PYTEST_BASE_TEMP'
    )
    if not basetemp:
        # PYTEST_BASE_TEMP isn't always set; fall back to scanning for a
        # parent that looks like a pytest-owned dir. We check that the
        # *basename* matches pytest's pattern (pytest-of-USER, pytest-N).
        for parent in path.resolve().parents:
            name = parent.name
            if name.startswith('pytest-of-') or (
                name.startswith('pytest') and any(part.startswith('pytest-') for part in parent.parts)
            ):
                return True
        return False
    try:
        path = path.resolve()
        base = Path(basetemp).resolve()
        path.relative_to(base)
        return True
    except (ValueError, OSError):
        return False


def assertPytestDataDirIsolated(label: str) -> None:
    """Part 27 E2 writer guard: when running under pytest, the resolved data
    dir MUST live under a pytest tmp basetemp. Logs (not raises) so a test
    that intentionally touches the live path can still proceed; the goal is
    to surface silent leaks of the form
    ``test sets AUGUST_DATA_DIR=/Users/me/.../data by mistake``.
    The autouse ``isolatedData`` fixture is the primary defense; this is the
    belt-and-braces check the plan called for.
    """
    if not os.environ.get('PYTEST_CURRENT_TEST'):
        return
    data_dir = os.environ.get('AUGUST_DATA_DIR')
    if not data_dir:
        # The hard guard in dataDir() will have raised; this is unreachable.
        return
    if not _isUnderPytestBasetemp(Path(data_dir)):
        logger.warning(
            'Part 27 E2: writer %s invoked under pytest with AUGUST_DATA_DIR=%r '
            'that is not under the pytest basetemp — this risks writing to '
            'the user\'s live stores. (See tests/conftest.py isolatedData.)',
            label,
            data_dir,
        )
