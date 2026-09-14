"""Which code is actually running — the runtime-drift detector.

The desktop app executes the AppData copy of ``backend-py`` that
``prepare-desktop-backend.mjs`` staged at build time, not the checkout a
developer is reading. Nothing on the running side used to identify its own
source, so a prompt sentence that existed in no checkout could only be chased
down through git history (audit finding 2026-09-15 #7 — four rounds of
``git log -S`` to prove a string was never in the repo).

One line in ``diagnose_proxy`` ("Runtime code: <sha> (installer-stamp)") turns
"is this the code I'm looking at?" into a question with an answer.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

# app/lib/build_info.py → parents[2] is backend-py/ in a checkout, and the
# staged backend-py/ inside resources/ when packaged.
_PKG_ROOT = Path(__file__).resolve().parents[2]

_INFO_CACHE: dict[str, str] | None = None


def _manifest() -> dict[str, object]:
    """``backend-runtime.json`` written beside ``backend-py/`` by the desktop build."""
    candidate = _PKG_ROOT.parent / 'backend-runtime.json'
    try:
        if candidate.is_file():
            data = json.loads(candidate.read_text(encoding='utf-8', errors='replace'))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _gitSha(directory: Path) -> str:
    try:
        proc = subprocess.run(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=str(directory),
            capture_output=True,
            timeout=3,
            check=False,
        )
        if proc.returncode == 0:
            return proc.stdout.decode('utf-8', errors='replace').strip()
    except Exception:
        pass
    return ''


def runtimeBuildInfo(*, refresh: bool = False) -> dict[str, str]:
    """``{'source', 'sha', 'builtAt', 'version'}`` for the code in this process.

    ``source`` is ``installer-stamp`` (running the packaged copy — the SHA is
    the commit staged at build time), ``git-checkout`` (dev run from a repo),
    or ``unknown``. Never raises: an unresolvable build is reported as
    ``unknown``, not an error in the tool that asked.
    """
    global _INFO_CACHE
    if _INFO_CACHE is not None and not refresh:
        return _INFO_CACHE
    from app.version import backend_version

    manifest = _manifest()
    if manifest:
        info = {
            'source': 'installer-stamp',
            'sha': str(manifest.get('sourceSha') or '') or 'unstamped',
            'builtAt': str(manifest.get('preparedAt') or ''),
            'branch': str(manifest.get('sourceBranch') or ''),
            'version': backend_version(),
        }
    else:
        sha = _gitSha(_PKG_ROOT)
        info = {
            'source': 'git-checkout' if sha else 'unknown',
            'sha': sha,
            'builtAt': '',
            'branch': '',
            'version': backend_version(),
        }
    _INFO_CACHE = info
    return info


def runtimeBuildLine() -> str:
    """One-line rendering for tool output / the system prompt."""
    info = runtimeBuildInfo()
    parts = [f"Runtime code: {info['sha'] or 'unknown'} ({info['source']})"]
    if info.get('branch'):
        parts.append(f"branch {info['branch']}")
    if info.get('builtAt'):
        parts.append(f"staged {info['builtAt'][:19]}")
    parts.append(f"app {info.get('version', '?')}")
    return ' · '.join(parts)
