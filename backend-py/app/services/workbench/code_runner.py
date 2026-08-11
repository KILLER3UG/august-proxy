"""
Code mode runner (smolagents CodeAgent / Oh My Pi eval-bridge lesson).

Per-session ``agent_mode='code'``: the model writes a fenced `````python````
block instead of native tool calls. The harness extracts the block, prepends
a small workspace-bound tool API (``read_file`` / ``write_file`` /
``run_command`` / ``list_files``), writes it under ``<workspace>/.aug/code_runs/``
and executes it through the existing sandboxed ``run_command`` machinery —
the same permission policy, path binding and approval flow as any shell
command. No new execution surface. The hardline credential guard is embedded
into every code run (``_GUARD_TEMPLATE``) so the child's helper API enforces
the same protected-path rules as the typed ``run_command`` / file tools.
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
    _reason = _hardline_check_path(path, for_write=False)
    if _reason:
        raise PermissionError(_reason)
    return _bind(path).read_text(encoding='utf-8', errors='replace')


def write_file(path, content):
    _reason = _hardline_check_path(path, for_write=True)
    if _reason:
        raise PermissionError(_reason)
    p = _bind(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content), encoding='utf-8')
    return 'ok'


def run_command(cmd, timeout=30):
    _reason = _hardline_check_command(str(cmd))
    if _reason:
        raise PermissionError(_reason)
    r = subprocess.run(
        str(cmd), shell=True, capture_output=True, text=True,
        timeout=timeout, cwd=str(_WORKSPACE) if _WORKSPACE is not None else None,
    )
    out = r.stdout or ''
    err = r.stderr or ''
    return f'Exit code: {{r.returncode}}\\n{{out}}\\n{{err}}'


def list_files(path='.'):
    _reason = _hardline_check_path(path, for_write=False)
    if _reason:
        raise PermissionError(_reason)
    p = _bind(path)
    return '\\n'.join(str(x.relative_to(p)) for x in sorted(p.rglob('*'))[:200])

'''


# The code-mode child runs as an isolated ``python -I`` subprocess and cannot
# import the backend, so the hardline rules are EMBEDDED into every code run.
# The regex patterns / reader set / mutating flags below are rendered from
# the live ``app.services.sandbox.hardline`` module by ``build_runner_source``
# (token substitution, so braces in the regexes need no escaping) — they
# cannot drift. The logic is a faithful port; tests/test_code_runner_hardline.py
# asserts parity with the real module on a command/path corpus.
_GUARD_TEMPLATE = r'''# Hardline credential guard (mirrors app/services/sandbox/hardline.py)
import re as _re

_PROTECTED_WRITE_RE = _re.compile(__WRITE_PATTERN__, _re.IGNORECASE)
_CREDENTIAL_READ_RE = _re.compile(__READ_PATTERN__, _re.IGNORECASE)
_WRITE_VERB_RE = _re.compile(__WRITE_VERB__, _re.IGNORECASE)
_ENV_TEMPLATE_RE = _re.compile(__ENV_TEMPLATE__, _re.IGNORECASE)
_READER_CMDS = frozenset(__READERS__)
_MUTATING_FLAG_RES = {
    _cmd: tuple(_re.compile(_p, _re.IGNORECASE) for _p in _flags)
    for _cmd, _flags in __MUTATING_FLAGS__.items()
}


def _hardline_canonical(text):
    return text.replace('\\', '/')


def _hardline_is_write_intent(command):
    """Faithful port of hardline._is_write_intent (readers + mutating flags)."""
    if _WRITE_VERB_RE.search(command):
        return True
    for _seg in _re.split(r'[;&|]{1,2}', command):
        _toks = [t.strip('"\' ').strip() for t in _re.split(r'\s+', _seg) if t.strip()]
        if not _toks:
            continue
        _first = _toks[0].split('/')[-1].split('\\')[-1].lower()
        if _first in ('sudo', 'xargs', 'env', 'command') and len(_toks) > 1:
            _first = _toks[1].split('/')[-1].split('\\')[-1].lower()
        if _first not in _READER_CMDS:
            return True
        _res = _MUTATING_FLAG_RES.get(_first)
        if _res:
            for _i, _tok in enumerate(_toks[1:], start=1):
                if any(_p.match(_tok) for _p in _res):
                    return True
                # gawk's two-token in-place form: `awk -i inplace '...' file`
                if _first == 'awk' and _tok == '-i' and _i + 1 < len(_toks) and _toks[_i + 1].lower() == 'inplace':
                    return True
    return False


def _hardline_check_command(command):
    if not command or not command.strip():
        return None
    _write = _hardline_is_write_intent(command)
    for _raw in _re.split(r'\s+', command):
        _tok = _hardline_canonical(_raw).strip('"\'')
        _lower = _tok.lower()
        if _write and _PROTECTED_WRITE_RE.search(_tok) and not (_ENV_TEMPLATE_RE.search(_tok) and '.env' in _lower):
            return 'hardline protected path in command: ' + _raw
        if not _write and _CREDENTIAL_READ_RE.search(_tok):
            return 'hardline credential read blocked: ' + _raw
    return None


def _hardline_check_path(path, for_write):
    if not path:
        return None
    _canon = _hardline_canonical(str(path))
    _lower = _canon.lower()
    if for_write and _PROTECTED_WRITE_RE.search(_canon) and not (_ENV_TEMPLATE_RE.search(_canon) and '.env' in _lower):
        return 'hardline protected path: ' + str(path)
    if not for_write and _CREDENTIAL_READ_RE.search(_canon):
        return 'hardline credential read blocked: ' + str(path)
    return None
'''


def extract_fenced_python(text: str) -> str | None:
    """Return the LAST fenced ```python block body (or None)."""
    matches = list(_FENCED_BLOCK_RE.finditer(text or ''))
    if not matches:
        return None
    return matches[-1].group(1).strip()


def build_runner_source(user_block: str, workspace_path: str) -> str:
    """Guard (rendered from the live hardline module) + preamble + user block."""
    from app.services.sandbox import hardline as _hardline

    guard = (
        _GUARD_TEMPLATE.replace('__WRITE_PATTERN__', repr(_hardline._PROTECTED_WRITE_PATTERN.pattern))
        .replace('__READ_PATTERN__', repr(_hardline._CREDENTIAL_READ_PATTERN.pattern))
        .replace('__WRITE_VERB__', repr(_hardline._WRITE_VERB_PATTERN.pattern))
        .replace('__ENV_TEMPLATE__', repr(_hardline._ENV_TEMPLATE_SUFFIX.pattern))
        .replace('__READERS__', repr(sorted(_hardline._READER_COMMANDS)))
        .replace(
            '__MUTATING_FLAGS__',
            repr({k: tuple(p.pattern for p in v) for k, v in _hardline._MUTATING_FLAG_PATTERNS.items()}),
        )
    )
    return guard + '\n\n' + _PREAMBLE.format(workspace=workspace_path or '') + '\n\n' + user_block


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
