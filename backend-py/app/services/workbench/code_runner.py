"""
Code mode runner (smolagents CodeAgent / Oh My Pi eval-bridge lesson).

Per-session ``agent_mode='code'``: the model writes a fenced `````python````
block instead of native tool calls. The harness extracts the block, prepends
a small workspace-bound tool API (``read_file`` / ``write_file`` /
``run_command`` / ``list_files``), writes it under ``<workspace>/.aug/code_runs/``
and executes it through the existing sandboxed ``run_command`` machinery —
the same permission policy, path binding and approval flow as any shell
command. No new execution surface.
"""

from __future__ import annotations

import logging
import re
import uuid

from app.json_narrowing import as_str

logger = logging.getLogger(__name__)

_FENCED_BLOCK_RE = re.compile(r'```python\s*\n(.*?)```', re.DOTALL | re.IGNORECASE)
_CODE_TIMEOUT_S = 60
_MAX_OUTPUT_CHARS = 24 * 1024

_PREAMBLE = '''\
# August code-mode tool API (workspace-bound)
import os as _os
# Scrub secrets before the model's code runs: the child python can read
# os.environ, so API keys / AUGUST_* config must not be visible to it.
for _k in list(_os.environ):
    if (
        _k.startswith('AUGUST_')
        or _k.endswith('_API_KEY')
        or _k.endswith('_API_TOKEN')
        or _k.endswith('_SECRET')
    ):
        _os.environ.pop(_k, None)
import subprocess
from pathlib import Path

_WORKSPACE = Path({workspace!r}) if {workspace!r} else None


def _bind(path):
    p = Path(str(path)).expanduser()
    if not p.is_absolute() and _WORKSPACE is not None:
        p = _WORKSPACE / p
    r = p.resolve()
    if _WORKSPACE is not None:
        try:
            r.relative_to(_WORKSPACE.resolve())
        except ValueError:
            raise PermissionError(f'path outside workspace: {{path}}')
    return r


def read_file(path):
    return _bind(path).read_text(encoding='utf-8', errors='replace')


def write_file(path, content):
    p = _bind(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content), encoding='utf-8')
    return 'ok'


def run_command(cmd, timeout=30):
    r = subprocess.run(
        str(cmd), shell=True, capture_output=True, text=True,
        timeout=timeout, cwd=str(_WORKSPACE) if _WORKSPACE is not None else None,
    )
    out = r.stdout or ''
    err = r.stderr or ''
    return f'Exit code: {{r.returncode}}\\n{{out}}\\n{{err}}'


def list_files(path='.'):
    p = _bind(path)
    return '\\n'.join(str(x.relative_to(p)) for x in sorted(p.rglob('*'))[:200])

'''


def extract_fenced_python(text: str) -> str | None:
    """Return the LAST fenced ```python block body (or None)."""
    matches = list(_FENCED_BLOCK_RE.finditer(text or ''))
    if not matches:
        return None
    return matches[-1].group(1).strip()


def build_runner_source(user_block: str, workspace_path: str) -> str:
    """Preamble (tool API) + the model's block."""
    return _PREAMBLE.format(workspace=workspace_path or '') + '\n\n' + user_block


def runner_path(workspace_path: str, session_id: str, tool_round: int) -> tuple[str, str]:
    """(dir, file_path) for a code-run script inside the workspace.

    Falls back to a temp dir when the session has no workspace.
    """
    import os
    import tempfile

    if workspace_path:
        run_dir = os.path.join(workspace_path, '.aug', 'code_runs')
    else:
        run_dir = os.path.join(tempfile.gettempdir(), 'august_code_runs')
    os.makedirs(run_dir, exist_ok=True)
    fname = f'{as_str(session_id, "sess")[:24]}_{tool_round}_{uuid.uuid4().hex[:6]}.py'
    return run_dir, os.path.join(run_dir, fname)


def format_result(result: str) -> str:
    """Cap the executed output for the transcript."""
    if len(result) > _MAX_OUTPUT_CHARS:
        return result[:_MAX_OUTPUT_CHARS] + (
            f'\n\n[... code output truncated at {_MAX_OUTPUT_CHARS} chars]'
        )
    return result


def runner_command(path: str) -> str:
    """Shell command that executes a code-run script.

    ``python -I`` = isolated mode: no user site-packages, no sys.path
    injection from the cwd — the same trust level as a typed ``run_command``
    (which can also run arbitrary python), with secrets scrubbed by the
    preamble. Code mode is NOT a security boundary: the model's block runs
    with the user's OS privileges inside the workspace, exactly like any
    command the user would approve.
    """
    return f'python -I -u "{path}"'
