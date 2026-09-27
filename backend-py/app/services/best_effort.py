"""best_effort(site) — the named swallow (audit B1 / P0#4).

The backend carried 941 ``except Exception`` blocks, ~800 of them followed by
a bare ``pass``. At that volume a real bug is indistinguishable from a
deliberate shrug, and none of the shrugs were greppable. New best-effort
blocks go through this helper instead:

* every swallow names its site — ``rg 'best_effort\\[' `` finds them all;
* the exception logs with ``exc_info=True`` (DEBUG by default), so the
  "deliberate" part is verifiable in the logs, not folklore;
* with ``AUGUST_STRICT_BEST_EFFORT=1`` (test runs) it re-raises instead, so
  what production would have eaten surfaces as a test failure.

Cancellation is deliberately not caught: ``except Exception`` misses
``CancelledError`` here too, so a cancelled turn can never be swallowed into
"best effort".

Legacy blocks are unchanged — the ruff ``BLE001`` ratchet (per-file-ignores
in pyproject.toml) keeps new blind excepts out of the tree while the old ones
migrate one file at a time.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_TRUE_VALUES = frozenset({'1', 'true', 'yes', 'on'})


def strict_best_effort() -> bool:
    """True when AUGUST_STRICT_BEST_EFFORT asks swallows to re-raise."""
    return os.environ.get('AUGUST_STRICT_BEST_EFFORT', '').strip().lower() in _TRUE_VALUES


@contextmanager
def best_effort(site: str, *, level: int = logging.DEBUG) -> Iterator[None]:
    """Run a block whose failure is genuinely expected — but name the site.

    ``with best_effort('session.title-backfill'):``
    Swallowed exceptions log as ``best_effort[<site>] swallowed`` with the
    traceback. Under ``AUGUST_STRICT_BEST_EFFORT=1`` the exception re-raises
    so tests catch what the swallow would have hidden.
    """
    try:
        yield
    except Exception:
        if strict_best_effort():
            raise
        logger.log(level, 'best_effort[%s] swallowed', site, exc_info=True)
