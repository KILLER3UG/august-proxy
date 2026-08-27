"""B0 — headless ``august-bench`` entry package (benchmark gate, plan §9.5).

Modules:
  * ``protocol``   — T9 conventions: JSONL envelopes, exit codes, schema gate
  * ``trajectory`` — ATIF-compatible trajectory builder
  * ``integrity``  — benchmark-integrity PRE_TOOL_USE hook
  * ``runner``     — the headless run engine over the real workbench loop
  * ``cli``        — argparse entry (``python -m app.bench``)
"""

from __future__ import annotations

from app.bench.protocol import EXIT_ERROR, EXIT_INPUT, EXIT_OK, EXIT_TURN_LIMIT
from app.bench.runner import BenchOptions, run_bench

__all__ = [
    'EXIT_OK',
    'EXIT_ERROR',
    'EXIT_INPUT',
    'EXIT_TURN_LIMIT',
    'BenchOptions',
    'run_bench',
]
