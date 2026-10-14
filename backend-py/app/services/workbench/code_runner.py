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

from app.json_narrowing import as_dict, as_str

logger = logging.getLogger(__name__)

_FENCED_BLOCK_RE = re.compile(r'```python\s*\n(.*?)```', re.DOTALL | re.IGNORECASE)
_CODE_TIMEOUT_S = 60
_MAX_OUTPUT_CHARS = 24 * 1024

# ── Trust boundary ──────────────────────────────────────────────────────────
# Code mode hands the model an unrestricted raw-Python interpreter (plus a
# ``call_tool`` bridge back into the full managed tool surface). That is a
# materially wider blast radius than any single typed tool, so the mode may
# only ever be ENTERED by a human:
#
#   * the composer's Code-mode picker (``POST /api/workbench/agent-mode``)
#     stamps the trust marker — that IS the explicit user confirmation;
#   * a model-initiated ``set_agent_mode("code")`` queues a pending mutation
#     (the same ApprovalBanner door every gated tool uses) and returns a
#     receipt; the user accepting it records the grant the handler consumes.
#
# A session sitting in code mode WITHOUT that marker (a session persisted by
# an older build, a forged attribute, a replayed tool call) is untrusted, and
# ``workbench._codeModeCellDenial`` refuses every cell before either the warm
# or the cold path executes anything.
TRUST_METADATA_KEY = 'codeModeUserApproved'

_CODE_MODE_PREVIEW = (
    'Switch this session to CODE MODE — the model will write fenced ```python '
    'blocks that August executes locally (workspace-bound file access, shell, '
    'and a bridge to the full tool surface). Only accept this if you want raw '
    'code execution in this chat.'
)

_CODE_MODE_REFUSAL_PLAN = (
    'Error: refused — this session is in Plan mode, so code mode is not available. '
    'Code mode runs model-authored Python locally, which Plan mode forbids. '
    'Investigate read-only, call submit_plan, and wait for the user to approve the '
    'plan (or to switch the session to Code mode themselves). Do not retry.'
)

_CODE_MODE_REFUSAL_READ_ONLY = (
    'Error: refused — this session\'s sandbox is read-only, so code mode cannot run. '
    'A code cell executes a raw Python interpreter, which the read-only sandbox '
    'blocks. Keep working with the read-only tools, or ask the user to switch the '
    'sandbox to Workspace / Full access. Do not retry.'
)

_CODE_MODE_REFUSAL_UNATTENDED = (
    'Error: refused — switching to code mode needs the user\'s confirmation and this '
    'is an unattended run, so no approver is available. Finish the turn and tell the '
    'user that Code mode must be enabled manually. Do not retry.'
)

_CODE_MODE_PENDING = (
    'Code mode requires the user\'s explicit confirmation. A permission prompt '
    '(Accept / Reject) was shown to them in the app. Do not retry and do not write '
    'a ```python block yet — if they accept, the next turn runs in code mode.'
)

_CODE_MODE_ALREADY_PENDING = (
    'Code mode is already waiting for the user\'s confirmation in the app. '
    'Do not retry until they accept or reject it.'
)


def is_code_mode_trusted(session: object) -> bool:
    """True when the USER explicitly enabled code mode for this session."""
    meta = getattr(session, 'metadata', None)
    return bool(as_dict(meta).get(TRUST_METADATA_KEY))


def mark_code_mode_trusted(session: object) -> None:
    """Stamp the user-confirmation marker (persisted with session metadata)."""
    meta = dict(as_dict(getattr(session, 'metadata', None)))
    meta[TRUST_METADATA_KEY] = True
    setattr(session, 'metadata', meta)


def clear_code_mode_trust(session: object) -> None:
    """Drop the marker — leaving code mode revokes the standing consent."""
    meta = as_dict(getattr(session, 'metadata', None))
    if not meta or TRUST_METADATA_KEY not in meta:
        return
    meta = dict(meta)
    meta.pop(TRUST_METADATA_KEY, None)
    setattr(session, 'metadata', meta)


def cell_policy_command() -> str:
    """Stable command identity for the parent guard/approval axes.

    A cold cell's real command embeds a per-cell script path, so fingerprinting
    IT would raise a fresh approval prompt for every cell and a "this chat"
    grant would never match the next one. The warm kernel already uses a
    fixed-shape boot command for the same reason (``WarmKernel.launch_command``)
    — both paths present this one shape to the guard/approval policy, while the
    sandbox still preflights the real command and the hardline guard still runs
    inside the cell.
    """
    return 'python -I -u "<august-code-cell>"'


def code_mode_switch_decision(session: object) -> tuple[bool, str]:
    """Model-initiated ``set_agent_mode("code")`` — never a silent escalation.

    Returns ``(allowed, message)``. ``allowed`` is True only when the session
    is already user-trusted, or the user just accepted the prompt (whose grant
    this consumes). Otherwise the message is a hard refusal (plan mode,
    read-only sandbox, unattended run) or the "a prompt is waiting" receipt.
    """
    from app.services.workbench import workbench as wb

    args: dict[str, object] = {'mode': 'code'}
    if is_code_mode_trusted(session):
        return True, 'Agent mode set to code (confirmed by the user for this session).'
    if wb.has_tool_grant(session, 'set_agent_mode', args):  # type: ignore[arg-type]
        mark_code_mode_trusted(session)
        return True, 'Agent mode set to code (approved by the user).'
    guard = wb.normalizeGuardMode(getattr(session, 'guardMode', None) or 'full')
    if guard == 'plan' and not bool(getattr(session, 'planApproved', False)):
        return False, _CODE_MODE_REFUSAL_PLAN
    sandbox = as_str(getattr(session, 'sandboxMode', '') or '').strip().lower()
    if sandbox in ('read-only', 'readonly', 'read'):
        return False, _CODE_MODE_REFUSAL_READ_ONLY
    if wb._approval_never_ask(wb._loadApprovalPolicy(session), session):  # type: ignore[arg-type]
        wb._record_unattended_denial(  # type: ignore[arg-type]
            session, 'set_agent_mode', 'model-initiated switch to code mode'  # type: ignore[arg-type]
        )
        return False, _CODE_MODE_REFUSAL_UNATTENDED
    pending = getattr(session, 'pendingMutations', None) or []
    for pm in pending:  # type: ignore[union-attr]
        if not isinstance(pm, dict):
            continue
        if as_str(pm.get('toolName')) == 'set_agent_mode' and (
            as_str(as_dict(pm.get('args')).get('mode')) == 'code'
        ):
            return False, _CODE_MODE_ALREADY_PENDING
    mutation = wb.createPendingMutation(session, 'set_agent_mode', args)  # type: ignore[arg-type]
    if mutation is None:
        return False, 'Error: could not open a code-mode confirmation prompt — ask the user to enable Code mode themselves.'
    mutation['kind'] = 'code_mode'
    mutation['approvalReason'] = 'model requested unrestricted local code execution'
    mutation['preview'] = _CODE_MODE_PREVIEW
    wb.saveSessions()
    wb._emitSessionStatus(session.id)  # type: ignore[attr-defined]
    return False, _CODE_MODE_PENDING

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
    # Bind FIRST, then ask the guard about the path the read actually lands on.
    # `sandbox.paths.bind_path` does exactly this for the typed file tools
    # (`check_hardline_path(str(resolved))`), and the port judged the raw string
    # instead: a workspace entry that resolves into a store — a junction or
    # symlink to `.aws`, the directory form Windows allows without privileges —
    # read the token file while the same call through the `read_file` tool was
    # refused. The name on the typed path is not the file that gets opened.
    _resolved = _bind(path)
    _reason = _hardline_check_path(str(_resolved), for_write=False)
    if _reason:
        raise PermissionError(_reason)
    return _resolved.read_text(encoding='utf-8', errors='replace')


def write_file(path, content):
    if _SANDBOX_READ_ONLY:
        raise PermissionError('read-only sandbox blocks write_file')
    p = _bind_write(path)
    _reason = _hardline_check_path(str(p), for_write=True)
    if _reason:
        raise PermissionError(_reason)
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
    # The listing door: the root itself, then every child. This is `listable_root`
    # + `listable_entry` in file-tool form.
    if _hardline_is_credential_store(str(p)):
        raise PermissionError('hardline credential store is not listable: ' + str(path))
    # Per child as well as per root: asking for the home directory names a
    # directory that IS listable and CONTAINS the stores, and rglob walks into
    # them. The root check alone would list every entry under .ssh, .aws, .docker.
    #
    # The child needs the FILE rule too, not just the directory rule. Measured on
    # one workspace: the typed `list_directory` hid `id_rsa` and `credentials`
    # while this named both — `_hardline_is_credential_store` is the DIRECTORY
    # predicate, and neither a key file nor a folder called `credentials` is a
    # credential store. The typed door asks `check_hardline_path` of every entry,
    # directory or file, so this does too.
    _keep = []
    for x in sorted(p.rglob('*')):
        if len(_keep) >= 200:
            break
        _xs = str(x)
        if _hardline_is_credential_store(_xs) or _hardline_check_path(_xs, False):
            continue
        _keep.append(str(x.relative_to(p)))
    return '\\n'.join(_keep)


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

# The strip set of the live tokenizer is exactly the two quote characters; built
# with chr() so this stays true when the literal is spliced into a runner file.
_QUOTES = chr(34) + chr(39)

_PROTECTED_WRITE_RE = _re.compile(__WRITE_PATTERN__, _re.IGNORECASE)
_CREDENTIAL_READ_RE = _re.compile(__READ_PATTERN__, _re.IGNORECASE)
_WRITE_VERB_RE = _re.compile(__WRITE_VERB__, _re.IGNORECASE)
_ENV_TEMPLATE_RE = _re.compile(__ENV_TEMPLATE__, _re.IGNORECASE)
_READER_CMDS = frozenset(__READERS__)
# The credential-store directory sets, August's own secret files and the
# enumerating / recursive-search verb tables, all injected from
# `sandbox.hardline` — see `_hardline_is_credential_store` for why they are here
# at all. Every one of these is a COPY-FROM-THE-MODULE injection; nothing here is
# hand-maintained, which is the only reason the port can be trusted to agree.
_CRED_DIRS = tuple(__CRED_DIRS__)
_STORE_DIRS = tuple(__STORE_DIRS__)
_SSH_PUBLIC = tuple(__SSH_PUBLIC__)
# The data directory and the two names inside it that decide what August RUNS.
# Injected because this file cannot import `app` — the runner is a separate
# process, and `_august_secret_files()` is the only other consumer of the same
# anchor on the live side.
_DATA_DIR = __DATA_DIR__
_POLICY_NAMES = tuple(__POLICY_NAMES__)
_BRAIN_PREFIXES = tuple(__BRAIN_PREFIXES__)
_AUGUST_SECRETS = tuple(__AUGUST_SECRETS__)
_ENUM_CMDS = frozenset(__ENUM_CMDS__)
_REC_SEARCH = frozenset(__REC_SEARCH__)
_REC_LONG = frozenset(__REC_LONG__)
_REC_VALUES = frozenset(__REC_VALUES__)
_REC_SHORT_RE = _re.compile(__REC_SHORT__)
_SHORT_NAME_RE = _re.compile(__SHORT_NAME__)
_WORD_END_RE = _re.compile(__WORD_END__)
_IFS_SPACED_RE = _re.compile(__IFS_SPACED__)
_SEGMENT_SPLIT_RE = _re.compile(__SEGMENT_SPLIT__)
_EXEC_WRAPPERS = tuple(__EXEC_WRAPPERS__)
_MUTATING_FLAG_RES = {
    _cmd: tuple(_re.compile(_p, _re.IGNORECASE) for _p in _flags)
    for _cmd, _flags in __MUTATING_FLAGS__.items()
}


def _hardline_canonical(text):
    return text.replace('\\', '/')


def _hardline_strip_dots(text):
    """Port of hardline._strip_dangling_dots: NTFS drops a trailing dot or space
    from the component it opens, so `.aws./sso/cache/<hash>.json` IS the SSO
    cache. The store tables match on whole components, so the alias matched
    nothing while `is_credential_directory` — which resolves, and resolving does
    the stripping on Windows — kept refusing it. Pure-dot components are `.` and
    `..` and stay.
    """
    _out = []
    for _part in text.split('/'):
        if _part.strip('.'):
            _part = _part.rstrip('. ')
        _out.append(_part)
    return '/'.join(_out)


def _hardline_tokenize(command):
    """Port of hardline._tokenize: the words a shell opens, not whitespace chunks.

    `ls -la ~/.ssh;` is a listing of `.ssh` with a terminator glued to the name,
    and `ls${IFS}~/.ssh` is the same listing with the shell's separator variable
    in place of the space. Both were measured getting past the live guard, and
    the port that splits only on whitespace disagrees with the typed door in the
    same way.
    """
    _words = []
    for _word in _re.split(r'\s+', _IFS_SPACED_RE.sub(' ', command)):
        if not _word:
            continue
        for _piece in _WORD_END_RE.split(_word):
            _piece = _piece.strip(_QUOTES).strip()
            if _piece:
                _words.append(_piece)
    return _words


def _hardline_segments(command):
    """Port of hardline._segments: each `;`/`&&`/`|` segment, tokenized once."""
    return [_t for _t in (_hardline_tokenize(_s) for _s in _SEGMENT_SPLIT_RE.split(command)) if _t]


def _hardline_executable(_toks):
    """Port of hardline._executable: the verb a segment runs, past `sudo`/`xargs`/…"""
    _first = _toks[0].split('/')[-1].split('\\')[-1].lower()
    if _first in _EXEC_WRAPPERS and len(_toks) > 1:
        return _toks[1].split('/')[-1].split('\\')[-1].lower()
    return _first


def _hardline_store_form(path):
    """Port of hardline._store_match_form: expand the shell's anchors, drop the
    dots/spaces NTFS strips from a component, and pay a resolve only when a
    component has the 8.3 short-name shape.

    `GOOGLE~1` IS `.google_workspace_mcp` on this volume, so matching the string
    the model typed refused the long name and allowed the short one; `~`, `$HOME`
    and `%USERPROFILE%` are the same class of miss, and so is `.aws.`, whose
    trailing dot the filesystem removes before it ever opens the directory. The
    port that does not do these disagrees with the typed doors in BOTH directions,
    which is what the parity corpus caught.
    """
    import os as _o

    text = str(path).strip('"\\' + "'")
    try:
        text = _o.path.expandvars(_o.path.expanduser(text))
    except (OSError, ValueError):
        pass
    canon = _hardline_strip_dots(_hardline_canonical(text))
    if _SHORT_NAME_RE.search(canon):
        try:
            from pathlib import Path as _P

            canon = _hardline_strip_dots(_hardline_canonical(str(_P(canon).resolve())))
        except (OSError, ValueError):
            pass
    return canon.lower()


def _hardline_agent_state_reason(canon):
    """Port of hardline._agent_state_reason: August's own instruction and
    execution state, write-only refusal.

    `.aug/skills/<dir>/SKILL.md` is a live scan root — `catalogue()` renders it
    into the next turn — so a write there is an installed instruction, and
    `mcp-servers.json` / `automations.json` / the brain database under the data
    directory decide what August runs and what it remembers. Code mode reached
    all of them with its own `write_file`, which is why the port carries the
    rule rather than leaving it on the typed door.

    `.aug/kernel/**` is the same class: `run_command` is exempted to execute
    that venv's interpreter, so a module dropped into its `site-packages` runs
    on the next cell — and code mode is the path most likely to be used to drop
    it.
    """
    parts = [p for p in canon.split('/') if p]
    for _i in range(1, len(parts)):
        if parts[_i] == 'skills' and parts[_i - 1] == '.aug':
            return 'agent skill layer (.aug/skills)'
        if parts[_i] == 'kernel' and parts[_i - 1] == '.aug':
            return 'agent kernel state (.aug/kernel)'
    # Ahead of the data-directory branch: the env override can move the memory
    # file outside the data directory, where a data-dir-anchored rule would not
    # see it.
    for _p in _BRAIN_PREFIXES:
        if canon == _p or canon.startswith(_p + '-') or canon.startswith(_p + '/'):
            return 'August durable memory (brain database)'
    if not _DATA_DIR or not canon.startswith(_DATA_DIR + '/'):
        return None
    inner = [p for p in canon[len(_DATA_DIR):].split('/') if p]
    if 'skills' in inner:
        return 'agent skill layer (data directory)'
    if inner and inner[-1] in _POLICY_NAMES:
        return 'August execution policy (' + inner[-1] + ')'
    return None


def _hardline_ssh_member_reason(_canon):
    """Port of hardline._ssh_member_reason: the `.ssh` exception is an ALLOW list.

    The read pattern names keys (`id_…`) and that is a list that goes stale —
    `~/.ssh/work_github` is a hand-named identity key and read clean through
    every door. Only a DIRECT member is judged; a path through a subdirectory is
    the subtree case `_hardline_store_reason` already owns.
    """
    _segs = [s for s in _canon.split('/') if s]
    for _i, _seg in enumerate(_segs):
        if _seg != '.ssh' or _i + 1 >= len(_segs) or _i + 2 < len(_segs):
            continue
        _member = _segs[_i + 1]
        if _member in _SSH_PUBLIC or _member.endswith('.pub'):
            return None
        return 'credential store .ssh member (' + _member + ') is not a public file'
    return None


def _hardline_store_reason(token):
    """Port of hardline._secret_store_reason: the store a path lives in or IS.

    This is the `_CREDENTIAL_STORES` half — root AND subtree — and the code-mode
    door never had it: it copied the write, credential-name and reader-command
    patterns out of `hardline` and not the store rule at all, so
    `read_file('~/.aws/credentials')` and `cat ~/.docker/config.json` were judged
    only by whether the FILENAME happened to match. `.aws/sso/cache/<hash>.json`
    and `.config/gh/hosts.yml` are exactly the names no pattern list guesses, which
    is why the original matches on the directory. `test_read_path_parity` caught
    the gap when the corpus grew these paths.

    The second half of the original is `_august_secret_files()` — August's own
    `config.json`, which holds `serviceConnections.github.token` and a Google
    `accessToken`. It was ported as a directory table and this call site only ever
    read the directory half, so code mode could `read_file(<dataDir>/config.json)`
    while every typed door refused the same path. The rule is the DATA DIRECTORY,
    never the filename: `config.json` is ordinary in any project tree.

    The third half is the `.ssh` SUBTREE. Reading one NAMED member of `.ssh` is
    the deliberate exception; a file inside a FOLDER inside the store is not, and
    the original refuses `~/.ssh/keys/deploy_token` while this port read it.
    """
    _canon = _hardline_store_form(token)
    _p = '/' + _canon.strip('/') + '/'
    for _store in _STORE_DIRS:
        if '/' + _store + '/' in _p:
            return _store
    _segs = [s for s in _canon.split('/') if s]
    for _i, _seg in enumerate(_segs):
        if _seg in _CRED_DIRS and _i + 2 < len(_segs):
            return 'credential store ' + _seg + ' subdirectory'
    _member = _hardline_ssh_member_reason(_canon)
    if _member:
        return _member
    if _canon in _AUGUST_SECRETS:
        return "August's own credential store"
    return None


def _hardline_is_credential_store(token):
    """Port of hardline.is_credential_directory for the LISTING doors.

    The two tables mean different things and the port keeps that difference,
    because collapsing them would be stricter than the doors it mirrors:

      * `_CREDENTIAL_DIRECTORIES` (`.ssh`) — the DIRECTORY is unlistable. A named
        non-secret member (`~/.ssh/config`, `authorized_keys`) stays readable,
        which is a considered decision the file-tool tests pin.
      * `_CREDENTIAL_STORES` (`.aws`, `.docker`, `.config/gh`, …) — unlistable
        ROOT **and subtree**, via `_hardline_store_reason`.

    The directory half matches on WHOLE components too, not on the last one. The
    first port took the last segment and called the missing `resolve()` a
    deliberate difference, because `list_files` hands it an already-resolved path
    — but `run_command` hands it the model's raw tokens, and `<home>/.ssh/.` is the
    same directory as `<home>/.ssh` with a segment the old rule judged instead of
    the directory it named. Any component of the path being a store is the store,
    which is also what the directory rule now says on the original side.
    """
    if _hardline_store_reason(token):
        return True
    _segs = [
        s for s in _hardline_strip_dots(_hardline_canonical(str(token))).strip(_QUOTES).lower().split('/') if s
    ]
    return any(_seg in _CRED_DIRS for _seg in _segs)


def _hardline_is_write_intent(command):
    """Faithful port of hardline._is_write_intent (readers + mutating flags)."""
    if _WRITE_VERB_RE.search(command):
        return True
    for _toks in _hardline_segments(command):
        _first = _hardline_executable(_toks)
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


def _hardline_enumerates(command):
    """Port of hardline._enumerates_a_directory: is some segment's verb a listing?

    The store-directory rule is a LISTING rule, and `is_credential_directory` now
    matches a store's whole subtree. Asked of every token of every command it
    refuses `cat ~/.ssh/authorized_keys`, which is the one member the read rule
    deliberately keeps — so the gate belongs on the verbs that enumerate, exactly
    as it does on the side this mirrors.

    Tokenization is `_hardline_tokenize`'s, shared with the two other readers of a
    command line, because the live module kept three copies of the split and they
    disagreed: `ls${IFS}~/.ssh` was one word here and two words everywhere else,
    which is the difference between a listing of the store and a refusal.
    """
    for _toks in _hardline_segments(command):
        _first = _hardline_executable(_toks)
        if _first in _ENUM_CMDS:
            return True
        # The grep family only walks with its recursive flag — `-r`, `-R`, the
        # combined `-rn` / `-lR` forms, `--recursive`, and GNU's two-token
        # `-d recurse`. Plain `grep pattern file` stays a reader.
        if _first in _REC_SEARCH:
            for _i, _t in enumerate(_toks[1:], start=1):
                if _REC_SHORT_RE.match(_t) or _t in _REC_LONG:
                    return True
                if _t == '-d' and _i + 1 < len(_toks) and _toks[_i + 1].lower() in _REC_VALUES:
                    return True
    return False


def _hardline_check_command(command):
    if not command or not command.strip():
        return None
    _write = _hardline_is_write_intent(command)
    _lists = _hardline_enumerates(command)
    for _raw in _hardline_tokenize(command):
        _tok = _hardline_canonical(_raw).strip('"\'')
        _lower = _tok.lower()
        if _write and _PROTECTED_WRITE_RE.search(_tok) and not (_ENV_TEMPLATE_RE.search(_tok) and '.env' in _lower):
            return 'hardline protected path in command: ' + _raw
        if _write:
            _state = _hardline_agent_state_reason(_hardline_store_form(_tok))
            if _state:
                return 'hardline protected ' + _state + ' in command: ' + _raw
        if not _write and _CREDENTIAL_READ_RE.search(_tok):
            return 'hardline credential read blocked: ' + _raw
        _store = _hardline_store_reason(_tok)
        if _store:
            return 'hardline protected ' + _store + ' in command: ' + _raw
        if _lists and _hardline_is_credential_store(_tok):
            return 'hardline credential store in command: ' + _raw
    return None


def _hardline_check_path(path, for_write):
    if not path:
        return None
    _canon = _hardline_canonical(str(path))
    _lower = _canon.lower()
    if for_write and _PROTECTED_WRITE_RE.search(_canon) and not (_ENV_TEMPLATE_RE.search(_canon) and '.env' in _lower):
        return 'hardline protected path: ' + str(path)
    if for_write:
        _state = _hardline_agent_state_reason(_hardline_store_form(str(path)))
        if _state:
            return 'hardline protected ' + _state + ': ' + str(path)
    if not for_write and _CREDENTIAL_READ_RE.search(_canon):
        return 'hardline credential read blocked: ' + str(path)
    _store = _hardline_store_reason(str(path))
    if _store:
        return 'hardline protected ' + _store + ': ' + str(path)
    # A credential DIRECTORY is refused by the LISTING doors (`listable_root`,
    # `list_files` below), while a named non-secret member of `.ssh` stays
    # readable — `read_file('~/.ssh/authorized_keys')` is a considered decision
    # the file-tool tests pin. Putting the rule in the path check here would make
    # code mode stricter than the doors it mirrors, and `test_read_path_parity`
    # is what caught that.
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
        .replace('__CRED_DIRS__', repr(sorted(_hardline._CREDENTIAL_DIRECTORIES)))
        .replace('__STORE_DIRS__', repr(sorted(_hardline._CREDENTIAL_STORES)))
        .replace('__SSH_PUBLIC__', repr(sorted(_hardline._SSH_PUBLIC_MEMBERS)))
        .replace('__DATA_DIR__', repr(_hardline._data_dir_form()))
        .replace('__POLICY_NAMES__', repr(sorted(_hardline._POLICY_FILE_NAMES)))
        .replace('__BRAIN_PREFIXES__', repr(sorted(_hardline._brain_db_prefixes())))
        .replace('__AUGUST_SECRETS__', repr(sorted(_hardline._august_secret_files())))
        .replace('__ENUM_CMDS__', repr(sorted(_hardline._ENUMERATING_COMMANDS)))
        .replace('__REC_SEARCH__', repr(sorted(_hardline._RECURSIVE_SEARCH_COMMANDS)))
        .replace('__REC_LONG__', repr(sorted(_hardline._RECURSIVE_LONG)))
        .replace('__REC_VALUES__', repr(sorted(_hardline._RECURSIVE_VALUES)))
        .replace('__REC_SHORT__', repr(_hardline._RECURSIVE_SHORT_RE.pattern))
        .replace('__SHORT_NAME__', repr(_hardline._SHORT_NAME_RE.pattern))
        .replace('__WORD_END__', repr(_hardline._SHELL_WORD_END_RE.pattern))
        .replace('__IFS_SPACED__', repr(_hardline._IFS_SPACED_RE.pattern))
        .replace('__SEGMENT_SPLIT__', repr(_hardline._SEGMENT_SPLIT_RE.pattern))
        .replace('__EXEC_WRAPPERS__', repr(list(_hardline._EXEC_WRAPPERS)))
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
