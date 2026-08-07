"""Run the loop-level harness eval suite (golden scenarios) and summarize.

The scenarios drive the REAL workbench turn loop with scripted models
(app/services/harness_eval.py + tests/test_harness_evals.py) and record
pass/fail runs into the KV store. Run nightly (or in CI) to measure whether
harness changes improve loop behavior over time.

Usage:
    cd backend-py && uv run python ../scripts/run_harness_evals.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / 'backend-py'


def main() -> int:
    cmd = [
        sys.executable,
        '-m',
        'pytest',
        '-q',
        '--no-cov',
        'tests/test_harness_evals.py',
    ]
    print('== running harness eval scenarios ==')
    result = subprocess.run(cmd, cwd=str(BACKEND))
    print()
    print('== latest recorded runs ==')
    print('GET /api/brain/harness/evals shows the recorded pass/fail history.')
    print('(recorded by the scenarios into the KV store: harness_eval:runs)')
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
