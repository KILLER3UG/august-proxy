"""File and shell tool handlers + registration (workspace-bound + sandboxed shell)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.services import tool_registry
from app.services.sandbox import (
    bind_path,
    policy_from_session,
    run_sandboxed,
    unsandboxed_grant_key,
)

_MAXFileSize = 10 * 1024 * 1024
_MAXSearchResults = 100
# Python fallback search bounds — rg isn't bundled on Windows, so the fallback
# is the common path; it must stay fast and interruptible instead of hanging
# the whole turn on a large tree.
_SEARCH_SKIP_DIRS = {
    'node_modules',
    'git',
    'venv',
    '__pycache__',
    'mypy_cache',
    'ruff_cache',
    'web-dist',
    'dist',
    'build',
    'releases',
    'target',
    'coverage',
    'next',
    'turbo',
}
_SEARCH_MAX_FILES = 25000
_SEARCH_FALLBACK_TIMEOUT_S = 20
_MAXCommandTimeout = 300
_DEFAULTCommandTimeout = 120
_ALLOWEDCommandPrefixes = [
    'git',
    'python',
    'node',
    'npm',
    'npx',
    'pip',
    'cargo',
    'rustc',
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'sort',
    'uniq',
    'grep',
    'find',
    'echo',
    'printf',
    'date',
    'pwd',
    'which',
    'whoami',
    'id',
    'mkdir',
    'cp',
    'mv',
    'rm',
    'touch',
    'chmod',
    'chown',
    'curl',
    'wget',
    'docker',
    'podman',
    'cd',
    '.',
    './',
    'pytest',
    'uv',
    'make',
    'go',
    'deno',
    'bun',
    'bash',
    'zsh',
    'sh',
    'pwsh',
    'powershell',
    'cmd',
]


def _session():
    try:
        from app.services.workbench.context import currentSessionId
        from app.services.workbench.sessions import get_workbench_session

        return get_workbench_session(currentSessionId.get())
    except Exception:
        return None


def _workspace() -> str:
    session = _session()
    if session is None:
        return ''
    return str(getattr(session, 'workspacePath', '') or '')


async def _readFile(
    path: str,
    offset: int | None = None,
    limit: int | None = None,
    start_line: int | None = None,
    end_line: int | None = None,
    **_extra: object,
) -> str:
    """Read a file from the filesystem (workspace-bound when session has a root).

    Optional ``offset``/``limit`` (1-based line start + line count) and
    ``start_line``/``end_line`` let models page large files. Unknown kwargs
    are ignored so provider schema drift cannot crash the tool.
    """
    filePath, err = bind_path(path, _workspace(), for_write=False)
    if err or filePath is None:
        return err or f'Error: Invalid path: {path}'
    if not filePath.exists():
        return f'Error: File not found: {path}'
    if not filePath.is_file():
        return f'Error: Not a file: {path}'
    size = filePath.stat().st_size
    if size > _MAXFileSize:
        return f'Error: File too large ({size} bytes). Maximum: {_MAXFileSize} bytes.'
    try:
        import aiofiles

        async with aiofiles.open(str(filePath), 'r', encoding='utf-8', errors='replace') as f:
            content = await f.read()
        # Hash-anchored edits (surpass #5): every read reports the file's
        # sha256 so the model can echo it back as `fileHash` on the next
        # write/edit — a mismatch rejects the patch before it corrupts.
        import hashlib

        digest = hashlib.sha256(content.encode('utf-8')).hexdigest()
        hashHeader = f'[sha256 {digest}]\n'
        # Line paging (agent-style): offset is 1-based start line when set.
        start = start_line if start_line is not None else offset
        if start is not None or limit is not None or end_line is not None:
            lines = content.splitlines(keepends=True)
            if not lines and content == '':
                return hashHeader + content
            # Treat offset as 1-based line number (common agent convention).
            try:
                start_i = max(1, int(start)) if start is not None else 1
            except (TypeError, ValueError):
                start_i = 1
            if end_line is not None:
                try:
                    end_i = max(start_i, int(end_line))
                except (TypeError, ValueError):
                    end_i = len(lines)
            elif limit is not None:
                try:
                    end_i = start_i + max(0, int(limit)) - 1
                except (TypeError, ValueError):
                    end_i = len(lines)
            else:
                end_i = len(lines)
            sliced = lines[start_i - 1 : end_i]
            header = f'[lines {start_i}-{min(end_i, len(lines))} of {len(lines)}]\n' if (
                start_i > 1 or end_i < len(lines)
            ) else ''
            return hashHeader + header + ''.join(sliced)
        return hashHeader + content
    except Exception as exc:
        return f'Error reading file: {exc}'


async def _writeFile(path: str, content: str, **_extra: object) -> str:
    """Write content to a file (workspace-bound).

    ``fileHash`` (the sha256 echoed by a prior ``read_file``) is accepted and
    ignored here — the hash-anchored edit gate in the executor already
    rejects stale patches before dispatch.
    """
    session = _session()
    mode = (getattr(session, 'sandboxMode', None) or 'workspace-write') if session else 'workspace-write'
    if str(mode).lower() in ('read-only', 'readonly', 'read'):
        return (
            'Error: Sandbox is read-only. Switch to Workspace or Full access before writing files.'
        )
    filePath, err = bind_path(path, _workspace(), for_write=True)
    if err or filePath is None:
        return err or f'Error: Invalid path: {path}'
    try:
        filePath.parent.mkdir(parents=True, exist_ok=True)
        import aiofiles

        async with aiofiles.open(str(filePath), 'w', encoding='utf-8') as f:
            await f.write(content)
        return f'Successfully wrote {len(content)} bytes to {path}'
    except Exception as exc:
        return f'Error writing file: {exc}'


async def _listDirectory(path: str) -> str:
    """List files and directories (workspace-bound)."""
    dirPath, err = bind_path(path, _workspace(), for_write=False)
    if err or dirPath is None:
        return err or f'Error: Invalid path: {path}'
    if not dirPath.exists():
        return f'Error: Path not found: {path}'
    if not dirPath.is_dir():
        return f'Error: Not a directory: {path}'
    try:
        entries = []
        for entry in sorted(dirPath.iterdir()):
            entryType = 'dir' if entry.is_dir() else 'file'
            size = entry.stat().st_size if entry.is_file() else 0
            entries.append(f'{entryType:4s} {entry.name:50s} {size:>10,} bytes')
        return '\n'.join(entries) if entries else '(empty directory)'
    except Exception as exc:
        return f'Error listing directory: {exc}'


async def _searchFiles(query: str, path: str = '.') -> str:
    """Search file contents using ripgrep or fallback grep (workspace-bound)."""
    ws = _workspace()
    if path in ('', '.', None):
        path = ws or '.'
    searchPath, err = bind_path(str(path), ws, for_write=False)
    if err or searchPath is None:
        return err or f'Error: Invalid path: {path}'
    if not searchPath.exists():
        return f'Error: Path not found: {path}'
    try:
        from app.lib.async_subprocess import SubprocessAborted, communicate_or_kill

        proc = await asyncio.create_subprocess_exec(
            'rg',
            '-n',
            '--max-count',
            '5',
            '-i',
            query,
            str(searchPath),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            limit=_MAXFileSize,
        )
        try:
            stdout, stderr = await communicate_or_kill(proc, timeout=30)
        except SubprocessAborted:
            return 'Error: Search timed out'
        # rg exit codes: 0 = matches, 1 = no matches (still success!), 2+ = error.
        # Treating 1 as failure used to dump every empty search into the slow
        # Python fallback.
        if proc.returncode == 1:
            return 'No matches found.'
        if proc.returncode == 0:
            output = stdout.decode('utf-8', errors='replace')
            lines = [ln for ln in output.split('\n') if ln.strip()]
            total = len(lines)
            if total > _MAXSearchResults:
                lines = lines[:_MAXSearchResults]
                lines.append(f'... and {total - _MAXSearchResults} more results')
            return '\n'.join(lines) if lines else 'No matches found.'
        return await _pySearchFiles(query, searchPath)
    except Exception:
        return await _pySearchFiles(query, searchPath)


def _pySearchFilesSync(query: str, searchPath: Path, cancelEvent: object | None = None) -> str:
    """Bounded synchronous Python fallback search (no external deps).

    Runs on a worker thread — never call directly on the event loop. Skips
    VCS/build/dependency directories, caps the number of files scanned, and
    checks the turn cancel event so Stop actually interrupts it.
    """
    results: list[str] = []
    filesScanned = 0
    needle = query.lower()
    isCancelled = getattr(cancelEvent, 'is_set', None)
    try:
        for filePath in searchPath.rglob('*'):
            if callable(isCancelled) and isCancelled():
                if results:
                    results.append('(Search cancelled — partial results.)')
                    return '\n'.join(results)
                return 'Search cancelled.'
            if filePath.is_dir():
                continue
            # Prune heavy/VCS dirs (rglob can't skip descent, so filter parts);
            # hidden dirs (.git, .venv, caches) are skipped by the dot check.
            parts = filePath.relative_to(searchPath).parts[:-1]
            if any((p.startswith('.') or p in _SEARCH_SKIP_DIRS for p in parts)):
                continue
            filesScanned += 1
            if filesScanned > _SEARCH_MAX_FILES:
                results.append(
                    f'... stopped after scanning {filesScanned} files '
                    '(workspace too large for the fallback search — install ripgrep for full coverage).'
                )
                break
            try:
                if filePath.stat().st_size > _MAXFileSize:
                    continue
                text = filePath.read_text('utf-8', errors='replace')
                for i, line in enumerate(text.split('\n'), 1):
                    if needle in line.lower():
                        rel = filePath.relative_to(searchPath)
                        results.append(f'{rel}:{i}:{line[:200].strip()}')
                        if len(results) >= _MAXSearchResults:
                            break
            except (UnicodeDecodeError, OSError):
                continue
            if len(results) >= _MAXSearchResults:
                break
        return '\n'.join(results) if results else 'No matches found.'
    except Exception as exc:
        return f'Error during search: {exc}'


async def _pySearchFiles(query: str, searchPath: Path) -> str:
    """Python fallback search — offloaded to a thread with a hard timeout so a
    huge tree can never hang the turn (and the tool card) indefinitely."""
    from app.lib.async_subprocess import current_subprocess_cancel

    cancelEvent = current_subprocess_cancel.get()
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_pySearchFilesSync, query, searchPath, cancelEvent),
            timeout=_SEARCH_FALLBACK_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        return (
            f'Error: Search timed out after {_SEARCH_FALLBACK_TIMEOUT_S}s — '
            'narrow the query or search a smaller path.'
        )


def _queue_sandbox_escape(session: object, command: str, denial: str) -> None:
    """Create an ApprovalBanner pending mutation for unsandboxed retry.

    Skipped in Full Access guard mode — that mode must not interrupt the
    composer with permission prompts.
    """
    try:
        mode = str(getattr(session, 'guardMode', '') or '').strip().lower()
        if mode in ('full', 'full-access', 'make-changes'):
            return
        from app.services.workbench.sessions import save_sessions
        from app.services.workbench.workbench import (
            _emitSessionStatus,
            _mutation_preview,
            createPendingMutation,
        )

        grant_path = unsandboxed_grant_key(command)
        args = {
            'command': command,
            'sandboxEscape': True,
            'path': grant_path,
            'denialReason': denial,
        }
        # Avoid duplicate pending cards for the same fingerprint
        pending = getattr(session, 'pendingMutations', None) or []
        for pm in pending:
            if not isinstance(pm, dict):
                continue
            if pm.get('toolName') == 'run_command' and (pm.get('args') or {}).get('path') == grant_path:
                return
        mutation = createPendingMutation(session, 'run_command', args)  # type: ignore[arg-type]
        if mutation is not None:
            mutation['preview'] = (
                f'Unsandboxed run requested.\nBlocked reason: {denial}\n\n'
                + _mutation_preview('run_command', args)
            )
            mutation['grantKey'] = f'run_command:{grant_path}'
            mutation['kind'] = 'sandbox_escape'
            session.status = 'awaiting_approval'  # type: ignore[attr-defined]
            save_sessions()
            _emitSessionStatus(session.id)  # type: ignore[attr-defined]
    except Exception:
        pass


async def _runCommand(
    command: str,
    timeout: float | int | None = None,
    timeout_s: float | int | None = None,
    cwd: str | None = None,
    **_extra: object,
) -> str:
    """Run a shell command inside the Codex-like sandbox.

    Non-interactive only: stdin is closed, pagers/prompts are discouraged via
    env. Unknown kwargs (e.g. proxy ``cwd``) are ignored so schema drift cannot
    crash the tool — workspace cwd comes from the session policy.
    """
    _ = cwd  # workspace cwd is applied by the sandbox policy, not caller cwd
    firstWord = command.strip().split()[0].lower() if command.strip() else ''
    if firstWord.endswith('.exe'):
        firstWord = firstWord[:-4]
    if firstWord not in _ALLOWEDCommandPrefixes and (not command.startswith('./')):
        return f"Error: Command '{firstWord}' is not in the allowed list."
    dangerous = [
        'rm -rf /',
        'rm -rf ~',
        ':(){ :|:& };:',
        'dd if=',
        '> /dev/',
        'mkfs.',
        # Relative-path destructive patterns the soft sandbox cannot catch by
        # path resolution alone (they operate on the whole cwd tree).
        'rm -rf *',
        'rm -rf .',
        'git clean -fdx',
        'del /s',
        'format c:',
    ]
    for pattern in dangerous:
        if pattern in command:
            return f'Error: Command contains dangerous pattern: {pattern}'

    raw_timeout = timeout_s if timeout_s is not None else timeout
    try:
        timeout_val = float(raw_timeout) if raw_timeout is not None else float(_DEFAULTCommandTimeout)
    except (TypeError, ValueError):
        timeout_val = float(_DEFAULTCommandTimeout)
    timeout_val = max(1.0, min(float(_MAXCommandTimeout), timeout_val))

    session = _session()
    allow_unsandboxed = False
    guard_full = False
    if session is not None:
        try:
            from app.services.workbench.workbench import has_tool_grant, normalizeGuardMode

            guard_full = normalizeGuardMode(getattr(session, 'guardMode', None) or 'full') == 'full'
            escape_args = {
                'command': command,
                'sandboxEscape': True,
                'path': unsandboxed_grant_key(command),
            }
            allow_unsandboxed = has_tool_grant(session, 'run_command', escape_args)
        except Exception:
            allow_unsandboxed = False

    policy = policy_from_session(
        sandbox_mode=getattr(session, 'sandboxMode', None) if session else None,
        workspace_path=_workspace(),
        sandbox_network=bool(getattr(session, 'sandboxNetwork', False)) if session else False,
        allow_unsandboxed=allow_unsandboxed,
    )

    result = await run_sandboxed(command, policy, timeout=timeout_val)
    # Only queue sandbox-escape approval outside Full Access — Full Access must
    # never interrupt the chat with a permission banner for terminal commands.
    if result.denial_reason and session is not None and not allow_unsandboxed:
        if result.hardline:
            # Hardline blocks cannot be granted away (even by an unsandboxed
            # approval) — surface the reason directly, never queue an
            # approval that would be denied anyway.
            return result.as_tool_text()
        if guard_full:
            return (
                f'[sandbox:{result.enforcement}] Blocked: {result.denial_reason}\n'
                'Sandbox policy blocked this command. Switch the sandbox control to '
                'Full access (or enable network) if you need it to run unsandboxed.'
            )
        _queue_sandbox_escape(session, command, result.denial_reason)
    return result.as_tool_text()


def register() -> None:
    """Register file and shell tools."""
    tool_registry.register(
        'read_file',
        'Read a file from the filesystem. Path must be absolute (or relative to workspace). '
        'Optional offset/limit (1-based start line + line count) page large files. '
        'Prefer this over shell head/cat/tail. Max ~10 MB. Sandboxed to the session workspace when set. '
        'The result is prefixed with the file\'s sha256 ("[sha256 …]") — echo it back as the '
        'fileHash argument of a later write_file so the harness rejects edits to files that '
        'changed since you read them.',
        _readFile,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Absolute path to the file to read.'},
                'offset': {
                    'type': 'integer',
                    'description': 'Optional 1-based line number to start reading from.',
                },
                'limit': {
                    'type': 'integer',
                    'description': 'Optional max number of lines to return from offset.',
                },
                'start_line': {
                    'type': 'integer',
                    'description': 'Optional alias for offset (1-based start line).',
                },
                'end_line': {
                    'type': 'integer',
                    'description': 'Optional inclusive end line (1-based).',
                },
            },
            'required': ['path'],
        },
    )
    tool_registry.register(
        'write_file',
        'Write content to a file, overwriting any existing content. Creates parent directories if needed. Sandboxed to the session workspace. '
        'If you recently read this file, pass the sha256 from the read result as fileHash — '
        'the write is rejected (without executing) when the file changed since that read.',
        _writeFile,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Absolute path to the file to write.'},
                'content': {'type': 'string', 'description': 'The content to write.'},
                'fileHash': {
                    'type': 'string',
                    'description': 'Optional sha256 from the last read_file result of this path. Rejects the write if the file changed since that read (content hash mismatch).',
                },
            },
            'required': ['path', 'content'],
        },
    )
    tool_registry.register(
        'list_directory',
        'List files and directories in a given path (absolute). Output shows dir/file prefix, size, and name. Sandboxed to workspace.',
        _listDirectory,
        {
            'type': 'object',
            'properties': {'path': {'type': 'string', 'description': 'Absolute path to the directory.'}},
            'required': ['path'],
        },
    )
    tool_registry.register(
        'search_files',
        'Search file contents using ripgrep or fallback grep. Case-insensitive. Path defaults to workspace.',
        _searchFiles,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'The text to search for.'},
                'path': {'type': 'string', 'description': 'Directory to search in (default: workspace).'},
            },
            'required': ['query'],
        },
    )
    tool_registry.register(
        'run_command',
        'Run a non-interactive shell command in the session sandbox (workspace-write by default, network off). '
        'Stdin is closed — never use pagers, REPLs, password prompts, or commands that wait for input. '
        'Prefer flags like --yes / -y / --non-interactive; GIT_PAGER=cat is already applied. '
        'On Windows, prefer PowerShell/cmd (or use read_file instead of head/cat/tail). '
        'Common Unix head/tail/cat/ls are auto-translated when possible. '
        f'Default timeout {_DEFAULTCommandTimeout}s (max {_MAXCommandTimeout}s); optional timeout_s.',
        _runCommand,
        {
            'type': 'object',
            'properties': {
                'command': {
                    'type': 'string',
                    'description': 'The non-interactive command to execute.',
                },
                'timeout_s': {
                    'type': 'number',
                    'description': (
                        f'Optional timeout in seconds (1–{_MAXCommandTimeout}, '
                        f'default {_DEFAULTCommandTimeout}).'
                    ),
                },
            },
            'required': ['command'],
        },
    )
