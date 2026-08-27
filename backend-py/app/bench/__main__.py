"""``python -m app.bench`` → august-bench CLI."""

from __future__ import annotations

import sys

from app.bench.cli import main

if __name__ == '__main__':
    sys.exit(main())
