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