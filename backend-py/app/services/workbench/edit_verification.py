"""T1 post-edit verification loop + T14 worktree-dedup gate (plan §9.4).

After a successful ``edit_lines`` / ``write_file`` (and the other mutation
tools) the harness runs the workspace's configured lint + optional test
command and appends the outcome to the tool result, so the model sees
failures immediately instead of discovering them rounds later.

- Config: ``<workspace>/.aug/verify.json`` (``lintCmd`` / ``testCmd`` /
  ``enabled`` / ``maxFixIterations``); missing commands fall back to
  auto-detection heuristics (ruff / eslint / pytest / npm test).
- Errors are reported with containing-function context — models mishandle
  bare line numbers, so each diagnostic site gets the enclosing ``def`` /
  ``class`` / ``function`` signature plus the offending source line. The
  scan is heuristic (no tree-sitter dependency).
- Bounded fix loop: each failed gate feeds a self-heal message counting the
  iteration (default 3). After the budget is exhausted the gate disarms for
  the rest of the turn (re-arms on the next user message).
- T14: before re-running a FAILED gate the git worktree state is hashed; if
  it is unchanged since the last failure the re-run is skipped, the attempt
  is counted, and the model is told to edit something first. Kills the
  "re-run the same failing test forever" loop; costs one git hash per retry.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING

from app.json_narrowing import as_bool, as_int, as_str

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

logger = logging.getLogger(__name__)

# Tools whose successful results trigger the verification gate.
EDIT_TOOLS = frozenset(
    {
        'write_file',
        'edit_file',
        'edit_lines',
        'create_file',
        'str_replace',
        'str_replace_editor',
        'apply_patch',
        'patch_file',
    }
)

DEFAULT_MAX_FIX_ITERATIONS = 3
VERIFY_CONFIG_RELPATH = '.aug/verify.json'
LINT_TIMEOUT_S = 60.0
TEST_TIMEOUT_S = 180.0
GIT_TIMEOUT_S = 10.0
_OUTPUT_HEAD_CHARS = 4000
_OUTPUT_TAIL_CHARS = 2000
_MAX_CONTEXT_SITES = 4

# npm's default placeholder test script — never treat it as a real suite.
_NPM_NO_TEST_MARKER = 'no test specified'


def detect_commands(workspace: Path) -> dict[str, str]:
    """Auto-detect lint/test commands for a workspace (no config file).

    Returns a dict with optional ``lintCmd`` / ``testCmd`` keys. Heuristics
    only look at marker files — they never execute anything.
    """
    cmds: dict[str, str] = {}
    try:
        pyproject = workspace / 'pyproject.toml'
        pyprojectText = ''
        if pyproject.is_file():
            pyprojectText = pyproject.read_text(encoding='utf-8', errors='replace')
        hasRuff = (
            '[tool.ruff' in pyprojectText
            or (workspace / 'ruff.toml').is_file()
            or (workspace / '.ruff.toml').is_file()
        )
        if hasRuff:
            cmds['lintCmd'] = 'ruff check {file}'
        if not cmds.get('lintCmd'):
            eslintMarkers = (
                'eslint.config.js',
                'eslint.config.mjs',
                'eslint.config.cjs',
                'eslint.config.ts',
                '.eslintrc',
                '.eslintrc.js',
                '.eslintrc.cjs',
                '.eslintrc.json',
                '.eslintrc.yml',
                '.eslintrc.yaml',
            )
            if any((workspace / name).exists() for name in eslintMarkers):
                cmds['lintCmd'] = 'npx --no-install eslint --no-color {file}'
        hasPytest = (
            '[tool.pytest.ini_options]' in pyprojectText
            or (workspace / 'pytest.ini').is_file()
            or '[tool:pytest]' in _readSmall(workspace / 'setup.cfg')
        )
        if hasPytest:
            cmds['testCmd'] = 'python -m pytest -q -x'
        if not cmds.get('testCmd'):
            pkgJson = workspace / 'package.json'
            if pkgJson.is_file():
                try:
                    pkg = json.loads(pkgJson.read_text(encoding='utf-8', errors='replace'))
                    testScript = as_str((pkg.get('scripts') or {}).get('test'), '')
                    if testScript and _NPM_NO_TEST_MARKER not in testScript:
                        cmds['testCmd'] = 'npm test --silent'
                except Exception:
                    pass
    except OSError:
        pass
    return cmds


def _readSmall(path: Path, limit: int = 64 * 1024) -> str:
    try:
        if path.is_file():
            with path.open('r', encoding='utf-8', errors='replace') as fh:
                return fh.read(limit)
    except OSError:
        pass
    return ''


def load_verify_config(workspace: Path) -> dict[str, object]:
    """Merge ``.aug/verify.json`` over the auto-detect heuristics.

    Result keys: ``enabled`` (bool), ``lintCmd`` / ``testCmd`` (str | ''),
    ``maxFixIterations`` (int ≥ 1). A missing/invalid config file falls
    back to pure auto-detection.
    """
    detected = detect_commands(workspace)
    lintCmd = detected.get('lintCmd', '')
    testCmd = detected.get('testCmd', '')
    enabled: bool | None = None  # None → derive from the merged commands
    maxFix = DEFAULT_MAX_FIX_ITERATIONS
    raw = _readSmall(workspace / VERIFY_CONFIG_RELPATH)
    if raw.strip():
        try:
            cfg = json.loads(raw)
            if isinstance(cfg, dict):
                lintCmd = as_str(cfg.get('lintCmd'), lintCmd)
                testCmd = as_str(cfg.get('testCmd'), testCmd)
                if 'enabled' in cfg:
                    enabled = as_bool(cfg.get('enabled'), False)
                if 'maxFixIterations' in cfg:
                    maxFix = max(1, as_int(cfg.get('maxFixIterations'), maxFix))
        except Exception:
            logger.debug('verify.json parse failed for %s', workspace, exc_info=True)
    return {
        'enabled': bool(lintCmd or testCmd) if enabled is None else (enabled and bool(lintCmd or testCmd)),
        'lintCmd': lintCmd,
        'testCmd': testCmd,
        'maxFixIterations': maxFix,
    }


async def worktree_hash(workspace: Path) -> str | None:
    """One-hash snapshot of the git worktree state (T14).

    Hashes ``git diff HEAD`` (tracked content changes) plus ``git status
    --porcelain`` (untracked/renamed names). Returns None when git is
    unavailable or the workspace is not a repo — dedup is then disabled.
    """
    try:
        diffProc = await asyncio.create_subprocess_exec(
            'git',
            'diff',
            'HEAD',
            cwd=str(workspace),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        diffOut, _ = await asyncio.wait_for(diffProc.communicate(), timeout=GIT_TIMEOUT_S)
        statusProc = await asyncio.create_subprocess_exec(
            'git',
            'status',
            '--porcelain',
            cwd=str(workspace),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        statusOut, _ = await asyncio.wait_for(statusProc.communicate(), timeout=GIT_TIMEOUT_S)
        if statusProc.returncode != 0:
            return None  # not a git repository
        digest = hashlib.sha256()
        digest.update(diffOut if diffProc.returncode == 0 else b'')
        digest.update(b'\x00')
        digest.update(statusOut)
        return digest.hexdigest()
    except Exception:
        return None


_DEF_LINE_RE = re.compile(
    r'^\s*(?:async\s+def\s+\w+|def\s+\w+|class\s+\w+'
    r'|export\s+(?:default\s+)?(?:async\s+)?function\s+\w+'
    r'|function\s+\w+'
    r'|(?:public|private|protected)\s+(?:static\s+)?[\w$]+\s*\()'
)


def containing_function_context(file_path: Path, line_no: int) -> str:
    """Approximate AST context without new deps: enclosing def/class line.

    Scans backward from the error line for the nearest function/class
    signature and returns it together with the offending source line.
    Returns '' when nothing useful is found.
    """
    try:
        if line_no < 1 or not file_path.is_file():
            return ''
        with file_path.open('r', encoding='utf-8', errors='replace') as fh:
            lines = fh.readlines()
        if line_no > len(lines):
            return ''
        errorLine = lines[line_no - 1].rstrip('\n')
        signature = ''
        signatureLine = 0
        for idx in range(line_no - 1, -1, -1):
            if _DEF_LINE_RE.match(lines[idx]):
                signature = lines[idx].strip()
                signatureLine = idx + 1
                break
        if not signature:
            return ''
        return (
            f'{file_path.name}:{line_no} in `{signature}` (line {signatureLine})\n'
            f'    {line_no}: {errorLine.strip()}'
        )
    except OSError:
        return ''


_DIAG_RE = re.compile(
    r'^(?P<path>[A-Za-z0-9_./\\~-]+\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|vue))'
    r':(?P<line>\d+)(?::(?P<col>\d+))?'
)
_TRACEBACK_RE = re.compile(r'File "(?P<path>[^"]+)", line (?P<line>\d+)')


def annotate_errors_with_context(workspace: Path, output: str) -> str:
    """Append containing-function context to lint/test diagnostics.

    Parses ``path:line[:col]`` (ruff/eslint/tsc) and ``File "...", line N``
    (pytest/traceback) sites, resolves them against the workspace, and adds
    an ``error context`` block for up to 4 distinct sites.
    """
    sites: list[tuple[Path, int]] = []
    seen: set[tuple[str, int]] = set()
    for line in output.splitlines():
        m = _DIAG_RE.match(line.strip()) or _TRACEBACK_RE.search(line)
        if not m:
            continue
        rawPath = m.group('path')
        try:
            lineNo = int(m.group('line'))
        except (TypeError, ValueError):
            continue
        candidate = Path(rawPath)
        if not candidate.is_absolute():
            candidate = workspace / candidate
        key = (str(candidate), lineNo)
        if key in seen:
            continue
        seen.add(key)
        sites.append((candidate, lineNo))
        if len(sites) >= _MAX_CONTEXT_SITES:
            break
    blocks: list[str] = []
    for path, lineNo in sites:
        block = containing_function_context(path, lineNo)
        if block:
            blocks.append(block)
    if not blocks:
        return output
    return output + '\n--- error context (containing function) ---\n' + '\n'.join(blocks)


def _cap_output(text: str) -> str:
    if len(text) <= _OUTPUT_HEAD_CHARS + _OUTPUT_TAIL_CHARS:
        return text
    omitted = len(text) - _OUTPUT_HEAD_CHARS - _OUTPUT_TAIL_CHARS
    return (
        text[:_OUTPUT_HEAD_CHARS]
        + f'\n[... {omitted} characters omitted ...]\n'
        + text[-_OUTPUT_TAIL_CHARS:]
    )


async def _run_gate_command(
    command: str, workspace: Path, session: 'WorkbenchSession | None', timeout: float
) -> tuple[bool, str]:
    """Run one gate command through the same sandbox path as run_command.

    Returns ``(ok, text)``. A sandbox denial reports as not-ok with the
    reason so the receipt can tell the model (or suggest disabling the gate).
    """
    from app.services.execution_world import run_sandboxed
    from app.services.sandbox.runner import policy_from_session

    guard_full = False
    if session is not None:
        try:
            from app.services.workbench.workbench import normalizeGuardMode

            guard_full = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full') == 'full'
        except Exception:
            guard_full = False
    policy = policy_from_session(
        sandbox_mode=getattr(session, 'sandboxMode', None) if session is not None else None,
        workspace_path=str(workspace),
        sandbox_network=False,
        allow_unsandboxed=guard_full,
    )
    result = await run_sandboxed(command, policy, timeout=timeout)
    if result.denial_reason:
        return False, f'[sandbox:{result.enforcement}] Blocked: {result.denial_reason}'
    parts: list[str] = []
    if result.stdout:
        parts.append(result.stdout.rstrip())
    if result.stderr:
        parts.append('STDERR:\n' + result.stderr.rstrip())
    text = '\n'.join(parts) if parts else '(no output)'
    ok = result.exit_code == 0 if result.exit_code is not None else result.ok
    return ok, text


def _verify_state(session: 'WorkbenchSession') -> dict[str, object]:
    state = getattr(session, '_verify_state', None)
    if not isinstance(state, dict):
        state = {
            'failStreak': 0,
            'lastFailHash': None,
            'skippedAttempts': 0,
            'disarmedUntilTurn': 0,
        }
        session._verify_state = state  # type: ignore[attr-defined]
    return state


def _edited_relpath(tool_input: dict[str, object], workspace: Path) -> str:
    raw = as_str(tool_input.get('path'), '') or as_str(tool_input.get('file_path'), '') or as_str(
        tool_input.get('filePath'), ''
    )
    if not raw:
        return ''
    try:
        resolved = Path(raw)
        if not resolved.is_absolute():
            resolved = workspace / resolved
        return resolved.relative_to(workspace).as_posix()
    except (ValueError, OSError):
        return raw


async def verify_after_edit(
    session: 'WorkbenchSession',
    tool_name: str,
    tool_input: dict[str, object],
) -> str:
    """Post-mutation hook (T1): run the lint/test gate after a successful edit.

    Returns the receipt block to append to the tool result, or '' when the
    gate does not apply (no workspace, disabled, no commands, not an edit).
    """
    if tool_name not in EDIT_TOOLS:
        return ''
    workspaceRaw = as_str(getattr(session, 'workspacePath', None), '')
    if not workspaceRaw:
        return ''
    workspace = Path(workspaceRaw)
    config = load_verify_config(workspace)
    if not config['enabled']:
        return ''
    lintCmd = as_str(config.get('lintCmd'), '')
    testCmd = as_str(config.get('testCmd'), '')
    maxFix = as_int(config.get('maxFixIterations'), DEFAULT_MAX_FIX_ITERATIONS)

    state = _verify_state(session)
    currentTurn = as_int(getattr(session, 'turnCount', 0), 0)
    if as_int(state.get('disarmedUntilTurn'), 0) and currentTurn >= as_int(
        state.get('disarmedUntilTurn'), 0
    ):
        # New user turn — fresh fix budget.
        state.update(
            {'failStreak': 0, 'lastFailHash': None, 'skippedAttempts': 0, 'disarmedUntilTurn': 0}
        )
    if as_int(state.get('failStreak'), 0) >= maxFix:
        return (
            f'[verification paused] {maxFix} consecutive fix iterations failed this turn — '
            'the gate is paused until the next message. Verify manually with run_command '
            'when ready, or rethink the approach before editing again.'
        )

    # T14: unchanged worktree since the last failed gate → skip the re-run.
    treeHash = await worktree_hash(workspace)
    lastFailHash = state.get('lastFailHash')
    if treeHash is not None and lastFailHash is not None and treeHash == lastFailHash:
        state['skippedAttempts'] = as_int(state.get('skippedAttempts'), 0) + 1
        attempt = as_int(state.get('skippedAttempts'), 1)
        return (
            f'[verification skipped] Workspace unchanged since the last failed gate '
            f'(attempt {attempt}) — edit something before retrying; '
            're-running the same gate cannot pass.'
        )

    relpath = _edited_relpath(tool_input, workspace)
    ranParts: list[str] = []

    if lintCmd:
        scoped = lintCmd.replace('{file}', relpath) if relpath else lintCmd.replace('{file}', '.')
        ok, text = await _run_gate_command(scoped, workspace, session, LINT_TIMEOUT_S)
        ranParts.append('lint')
        if not ok:
            return _failure_receipt(
                session, state, treeHash, maxFix, f'lint: {scoped}', text, workspace
            )
    if testCmd:
        ok, text = await _run_gate_command(testCmd, workspace, session, TEST_TIMEOUT_S)
        ranParts.append('tests')
        if not ok:
            return _failure_receipt(
                session, state, treeHash, maxFix, f'test: {testCmd}', text, workspace
            )

    if not ranParts:
        return ''
    state['failStreak'] = 0
    state['lastFailHash'] = None
    state['skippedAttempts'] = 0
    return f"[verification passed] {' + '.join(ranParts)} clean."


def _failure_receipt(
    session: 'WorkbenchSession',
    state: dict[str, object],
    treeHash: str | None,
    maxFix: int,
    gateLabel: str,
    output: str,
    workspace: Path,
) -> str:
    state['failStreak'] = as_int(state.get('failStreak'), 0) + 1
    state['lastFailHash'] = treeHash
    state['skippedAttempts'] = 0
    streak = as_int(state['failStreak'], 1)
    annotated = annotate_errors_with_context(workspace, _cap_output(output))
    if streak >= maxFix:
        state['disarmedUntilTurn'] = as_int(getattr(session, 'turnCount', 0), 0) + 1
        tail = (
            f'Fix iteration {streak}/{maxFix} failed — fix budget exhausted for this turn. '
            'Do NOT re-run the same fix; the gate is paused until the next message. '
            'Rethink the approach or verify manually with run_command.'
        )
    else:
        tail = (
            f'Fix iteration {streak}/{maxFix} — fix the reported errors, then edit the file '
            'again; the gate re-runs automatically after your next edit.'
        )
    return f'[verification FAILED — {gateLabel}]\n{annotated}\n\n{tail}'
