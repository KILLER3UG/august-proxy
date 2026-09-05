"""
Resolve data directory paths. Respects AUGUST_DATA_DIR env var.
"""

from __future__ import annotations

import os
from pathlib import Path


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
