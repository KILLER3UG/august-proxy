"""Atomic JSON file writer.

This module provides a single public function, ``write_json_atomic``, that
writes JSON data to a file atomically by serialising to a temporary file in
the same directory and then renaming it into place with ``os.replace``.
The rename is atomic on a single filesystem, so any reader (or a crash /
interruption mid-write) always sees either the old file or the complete
new file — never a partially written one.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Callable


def _refuse_live_store_write(target: str) -> None:
    """Refuse, under pytest, a JSON write whose target is in the live data dir.

    Outside pytest this is a no-op: the app writes its own stores on every save.
    """
    if not os.environ.get('PYTEST_CURRENT_TEST'):
        return
    from app.lib.paths import _repoDataDir

    live = os.path.abspath(str(_repoDataDir()))
    # A target that merely shares a prefix (`data_2`) is not the live store.
    if os.path.commonpath([target, live]) == live:
        # Raise on the TARGET, not on AUGUST_DATA_DIR: a test can point the env
        # var at a temp dir and still pass a live-store path to the writer, and
        # that is exactly the shape of the leak this fixes.
        raise RuntimeError(
            'pytest run tried to write into the live data store '
            f'({target!r}) — refusing (see tests/conftest.py isolatedData and '
            'tests/test_data_dir_isolation_guard.py)'
        )


def write_json_atomic(
    path: str | os.PathLike[str],
    data: object,
    indent: int = 2,
    default: Callable[[object], object] | None = None,
) -> None:
    """Write ``data`` to ``path`` as JSON atomically.

    The payload is serialised to a temporary file created in the *same*
    directory as ``path`` and then moved into place with ``os.replace``.
    Because the rename is atomic on a single filesystem, any reader (or a
    crash / interruption mid-write) always sees either the old file or the
    complete new file — never a partially written one.

    Args:
        path: Destination file path (``str`` or ``os.PathLike``).
        data: JSON-serialisable object to write.
        indent: Indentation passed to ``json.dumps`` (default ``2``).
        default: Optional ``default`` callable passed to ``json.dumps`` for
            non-serialisable values (e.g. ``str``).
    """
    text = json.dumps(data, indent=indent, ensure_ascii=False, default=default)
    target = os.path.abspath(path)
    # This is the single choke point every user-store JSON write passes through:
    # config.json, providers.json, automations.json, aliases, background review.
    # A pytest run that resolves a target INSIDE the live data dir is writing to
    # the user's stores — measured: a test value ('judge-model-x') sat in the
    # real config for a month. Guarded here rather than per writer, because the
    # per-writer list was how it was missed in the first place.
    _refuse_live_store_write(target)
    tmp = tempfile.NamedTemporaryFile(
        mode='w',
        encoding='utf-8',
        dir=os.path.dirname(target),
        delete=False,
        suffix='.tmp',
    )
    try:
        with tmp:
            tmp.write(text)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp.name, target)
    except BaseException:
        # Best-effort cleanup of the partial temp file.
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise