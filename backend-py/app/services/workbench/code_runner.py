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
# Case-insensitive + credential-shaped names (mirrors async_subprocess).
import re as _os_re
for _k in list(_os.environ):
    # Same shape as app.lib.async_subprocess._CREDENTIAL_ENV_RE: AUGUST_*
    # prefix OR credential-suffixed (case-insensitive). The old bare `AUGUST_`
    # branch only matched the exact literal, so AUGUST_BRAIN_SQLITE_FILE /
    # AUGUST_DATA_DIR leaked — fixed with the prefix wildcard (P3.2 audit).
    if _os_re.match(r'^(?:AUGUST_\w*.*|.*(?:API[_-]?KEY|_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH(?:[_-]|$)).*)$', _k, _os_re.IGNORECASE):
        _os.environ.pop(_k, None)
import subprocess
from pathlib import Path

_WORKSPACE = Path({workspace!r}) if {workspace!r} else None
# Session sandbox mode: read-only sessions must not be able to mutate the
# filesystem through the code runner (the outer python is also blocked by
# soft_preflight; this is the in-process second gate).
_SANDBOX_READ_ONLY = {sandbox_read_only!r}


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


def _bind_write(path):
    if _SANDBOX_READ_ONLY:
        raise PermissionError('read-only sandbox blocks file writes')
    p = _bind(path)
    if _WORKSPACE is None:
        # No workspace: writes are gated to the system temp area, mirroring
        # the file tool's bind_path rule.
        import tempfile
        try:
            p.relative_to(Path(tempfile.gettempdir()).resolve())
        except ValueError:
            raise PermissionError('no workspace configured — writes are only allowed under the system temp directory')
    return p


def read_file(path):
    _reason = _hardline_check_path(path, for_write=False)
    if _reason:
        raise PermissionError(_reason)
    return _bind(path).read_text(encoding='utf-8', errors='replace')


def write_file(path, content):
    if _SANDBOX_READ_ONLY:
        raise PermissionError('read-only sandbox blocks write_file')
    _reason = _hardline_check_path(path, for_write=True)
    if _reason:
        raise PermissionError(_reason)
    p = _bind_write(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content), encoding='utf-8')
    return 'ok'


def run_command(cmd, timeout=30):
    if _SANDBOX_READ_ONLY:
        raise PermissionError('read-only sandbox blocks run_command — use read_file/list_files instead')
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


# ---- T13 tool bridge -----------------------------------------------------
# call_tool reaches the FULL managed tool surface by bridging back into the
# running backend over localhost with a short-lived one-shot token. The
# parent re-applies the same guard/approval gates, so code mode cannot
# bypass the permission axes.
_BRIDGE_URL = {bridge_url!r}
_BRIDGE_TOKEN = {bridge_token!r}
_KERNEL_DIR = Path({kernel_dir!r}) if {kernel_dir!r} else None


def call_tool(name, **args):
    if not _BRIDGE_URL or not _BRIDGE_TOKEN:
        raise RuntimeError('tool bridge not available for this code run')
    import json as _json
    import urllib.request as _urlreq
    payload = _json.dumps({{'token': _BRIDGE_TOKEN, 'tool': name, 'args': args}}).encode('utf-8')
    req = _urlreq.Request(
        _BRIDGE_URL, data=payload,
        headers={{'Content-Type': 'application/json'}}, method='POST',
    )
    try:
        with _urlreq.urlopen(req, timeout=300) as _resp:
            body = _resp.read().decode('utf-8', errors='replace')
    except Exception as _bridge_err:
        raise RuntimeError(f'tool bridge call failed: {{_bridge_err}}')
    try:
        data = _json.loads(body)
    except Exception:
        return body
    if isinstance(data, dict):
        if 'error' in data and 'result' not in data:
            raise RuntimeError(f'tool bridge error: {{data["error"]}}')
        if 'result' in data:
            return data['result']
    return body

'''


# ---- T13 persistent kernel variables ------------------------------------
# RESTORE runs before the model's block: previously persisted variables are
# loaded back into the module namespace so state survives across turns.
_RESTORE_HEAD = '''
# August kernel: restore persistent variables from the previous code run.
if _KERNEL_DIR is not None and _KERNEL_DIR.is_dir():
    import pickle as _pickle
    for _vf in sorted(_KERNEL_DIR.glob('var_*.pkl')):
        _vname = _vf.stem[len('var_'):]
        try:
            globals()[_vname] = _pickle.loads(_vf.read_bytes())
        except Exception as _restore_err:
            print(f'[kernel] could not restore {{_vname}}: {{_restore_err}}')
'''


# SNAPSHOT runs after the block: every user variable is pickled independently
# (per-variable + total caps); unpicklable/oversized are skipped and reported,
# never fatal. Deleted variables are pruned from the persisted state.
_SNAPSHOT_TAIL = '''
# August kernel: snapshot persistent variables for the next code run.
if _KERNEL_DIR is not None:
    import json as _kjson
    import pickle as _pickle
    import types as _types
    _PER_VAR_CAP = {per_var_cap}
    _TOTAL_CAP = {total_cap}
    try:
        _KERNEL_DIR.mkdir(parents=True, exist_ok=True)
        _present = set()
        _saved = []
        _skipped = []
        _total = 0
        for _vname in list(globals()):
            if _vname.startswith('_'):
                continue
            _vval = globals()[_vname]
            if isinstance(_vval, _types.ModuleType) or callable(_vval):
                continue
            _present.add(_vname)
            try:
                _blob = _pickle.dumps(_vval)
            except Exception:
                _skipped.append(_vname + ': unpicklable')
                continue
            if len(_blob) > _PER_VAR_CAP:
                _skipped.append(_vname + ': exceeds per-variable cap (' + str(len(_blob)) + ' bytes)')
                continue
            if _total + len(_blob) > _TOTAL_CAP:
                _skipped.append(_vname + ': total cap reached')
                continue
            try:
                (_KERNEL_DIR / ('var_' + _vname + '.pkl')).write_bytes(_blob)
                _total += len(_blob)
                _saved.append(_vname)
            except Exception as _werr:
                _skipped.append(_vname + ': write failed (' + str(_werr) + ')')
        for _vf in _KERNEL_DIR.glob('var_*.pkl'):
            _old = _vf.stem[len('var_'):]
            if _old not in _present:
                try:
                    _vf.unlink()
                except Exception:
                    pass
        (_KERNEL_DIR / '_report.json').write_text(_kjson.dumps(
            {{'saved': _saved, 'skipped': _skipped, 'totalBytes': _total}}
        ), encoding='utf-8')
        if _saved or _skipped:
            print('[kernel] persisted ' + str(len(_saved)) + ' variable(s)'
                  + (', skipped ' + str(len(_skipped)) if _skipped else ''))
    except Exception as _snap_err:
        print(f'[kernel] snapshot failed (non-fatal): {{_snap_err}}')
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


# Result capture (code-mode contract): the prompt tells the model it may
# "assign the final answer to a variable named result" — surface it here so
# the promise is real (previously only stdout was returned, silently
# dropping the assigned value). Printed after the block's own output.
_RESULT_CAPTURE_TAIL = '''

# August result capture: a `result` variable (per the code-mode contract) is
# surfaced so the harness returns what the model assigned, not just stdout.
try:
    if 'result' in dir():
        _captured = result
        if isinstance(_captured, str):
            print('')
            print('[result]', _captured)
        else:
            print('')
            print('[result]', repr(_captured))
except Exception:
    pass
'''


def build_runner_source(
    user_block: str,
    workspace_path: str,
    sandbox_mode: str = '',
    bridge_url: str = '',
    bridge_token: str = '',
    kernel_dir: str = '',
) -> str:
    """Guard (rendered from the live hardline module) + preamble + user block
    + the result-capture tail (honors the "assign to `result`" contract).

    ``sandbox_mode`` (read-only / workspace-write / full) is rendered into the
    preamble so the embedded tool API enforces the same mutation rules as the
    typed tools — a read-only session cannot write through code mode.

    T13: ``bridge_url`` / ``bridge_token`` wire the ``call_tool`` bridge to the
    running backend; ``kernel_dir`` enables persistent variables (restored
    before the block, snapshotted after).
    """
    from app.services.sandbox import hardline as _hardline
    from app.services.workbench.kernel import PER_VARIABLE_CAP_BYTES, TOTAL_CAP_BYTES

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
    sandbox_read_only = (sandbox_mode or '').strip().lower().replace('_', '-') == 'read-only'
    return (
        guard
        + '\n\n'
        + _PREAMBLE.format(
            workspace=workspace_path or '',
            sandbox_read_only=sandbox_read_only,
            bridge_url=bridge_url or '',
            bridge_token=bridge_token or '',
            kernel_dir=kernel_dir or '',
        )
        + '\n\n'
        + _RESTORE_HEAD.format()
        + '\n\n'
        + user_block
        + '\n\n'
        + _SNAPSHOT_TAIL.format(per_var_cap=PER_VARIABLE_CAP_BYTES, total_cap=TOTAL_CAP_BYTES)
        + _RESULT_CAPTURE_TAIL
    )


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


def runner_command(path: str, interpreter: str = '') -> str:
    """Shell command that executes a code-run script.

    ``python -I`` = isolated mode: no user site-packages, no sys.path
    injection from the cwd — the same trust level as a typed ``run_command``
    (which can also run arbitrary python), with secrets scrubbed by the
    preamble. Code mode is NOT a security boundary: the model's block runs
    with the user's OS privileges inside the workspace, exactly like any
    command the user would approve.

    ``interpreter`` (T13) overrides the default ``python`` — the caller passes
    the pre-seeded kernel venv's interpreter when one is provisioned, so cells
    can rely on the common packages without a per-run install.
    """
    exe = (interpreter or '').strip() or 'python'
    # Quote the interpreter only if it carries spaces (a venv path rarely does,
    # but a Windows Program Files path would).
    exe_token = f'"{exe}"' if ' ' in exe else exe
    return f'{exe_token} -I -u "{path}"'
