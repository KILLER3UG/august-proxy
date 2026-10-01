"""TTL cache for tool results — list_directory + read_file (30s per turn)."""

from __future__ import annotations

import hashlib
import time

_TTL_S = 30.0
_MAX_ENTRIES = 200

_cache: dict[str, tuple[float, str]] = {}


def _key(session_id: str, tool: str, args: str) -> str:
    h = hashlib.sha256(args.encode()).hexdigest()[:12]
    return f'{session_id}:{tool}:{h}'


def get(session_id: str, tool: str, args: str) -> str | None:
    k = _key(session_id, tool, args)
    entry = _cache.get(k)
    if not entry:
        return None
    ts, val = entry
    if time.time() - ts > _TTL_S:
        _cache.pop(k, None)
        return None
    return val


def put(session_id: str, tool: str, args: str, value: str) -> None:
    if len(_cache) >= _MAX_ENTRIES:
        oldest = min(_cache.items(), key=lambda kv: kv[1][0])[0]
        _cache.pop(oldest, None)
    _cache[_key(session_id, tool, args)] = (time.time(), value)


def invalidate_path(session_id: str, path_prefix: str) -> None:
    # Clear every entry for the session on any write.
    #
    # This used to narrow first — building `to_del`, then popping only keys whose
    # cached value contained the written path — and then cleared all of them
    # anyway three lines later. The narrow pass was pure dead work whose result
    # was unconditionally discarded, and it cost a full scan of the cache on
    # every single write. `path_prefix` stays in the signature because it is the
    # caller's contract, and narrowing the invalidation back to it is a
    # behaviour change rather than a cleanup: the two are not equivalent once a
    # session's cache holds entries unrelated to the path being written.
    _ = path_prefix
    for k in [k for k in list(_cache.keys()) if k.startswith(f'{session_id}:')]:
        _cache.pop(k, None)


def clear() -> None:
    _cache.clear()
