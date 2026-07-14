"""Run P0 baseline suite and print aggregate lines for the Progress Log.

Usage (from repo root):
  backend-py/.venv/Scripts/python.exe -m pytest backend-py/tests/test_perf_p0_baselines.py -q -s
  backend-py/.venv/Scripts/python.exe backend-py/scripts/p0_explain_plans.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    py = sys.executable
    r1 = subprocess.run(
        [py, '-m', 'pytest', str(ROOT / 'backend-py' / 'tests' / 'test_perf_p0_baselines.py'), '-q', '-s'],
        cwd=str(ROOT),
    )
    r2 = subprocess.run(
        [py, str(ROOT / 'backend-py' / 'scripts' / 'p0_explain_plans.py')],
        cwd=str(ROOT),
    )
    return 0 if r1.returncode == 0 and r2.returncode == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
