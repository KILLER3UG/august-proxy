"""Backward-compatible entry point → ``_check_fts_query_hygiene.py``.

Prefer the permanent name. This wrapper remains so older docs and muscle
memory keep working.
"""

from __future__ import annotations

import runpy
from pathlib import Path

if __name__ == '__main__':
    target = Path(__file__).with_name('_check_fts_query_hygiene.py')
    runpy.run_path(str(target), run_name='__main__')
