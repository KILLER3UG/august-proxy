"""Built-in hooks registered at application startup.

Each hook is a focused, single-responsibility handler. They are
registered in priority order (lower = runs first):
  10: secret_guard (blocks credential exposure)
  20: sensitive_code (warns on sensitive patterns)
  50: blast_radius (scores change impact)

(The 60: ``test_mapping`` hook — "warns on untested critical files" — was
retired with the test suite on 2026-10-17: its only input was the test tree, so
with no tests it could only warn on every critical-file write.)
"""

from __future__ import annotations

import logging

from app.services.hooks.registry import registry

logger = logging.getLogger(__name__)


def register_builtin_hooks() -> None:
    """Register all built-in hooks. Called once at startup."""
    from app.services.hooks.blast_radius import register as register_blast_radius
    from app.services.hooks.secret_guard import register as register_secret_guard
    from app.services.hooks.sensitive_code import register as register_sensitive_code

    register_secret_guard(registry)
    register_sensitive_code(registry)
    register_blast_radius(registry)

    logger.info('Built-in hooks registered: %d', len(registry._hooks))
