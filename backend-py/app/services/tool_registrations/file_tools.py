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
_MAXCommandTimeout = 300
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


async def _readFile(path: str) -> str:
    """Read a file from the filesystem (workspace-bound when session has a root)."""
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
        return content
    except Exception as exc:
        return f'Error reading file: {exc}'


async def _writeFile(path: str, content: str) -> str:
    """Write content to a file (workspace-bound)."""
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
            limit=_MAXFileSize,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode == 0:
            output = stdout.decode('utf-8', errors='replace')
            lines = output.split('\n')
            if len(lines) > _MAXSearchResults:
                lines = lines[:_MAXSearchResults]
                lines.append(f'... and {len(lines) - _MAXSearchResults} more results')
            return '\n'.join(lines)
        return await _pySearchFiles(query, searchPath)
    except asyncio.TimeoutError:
        return 'Error: Search timed out'
    except Exception:
        return await _pySearchFiles(query, searchPath)


async def _pySearchFiles(query: str, searchPath: Path) -> str:
    """Python fallback file search (no external deps)."""
    results = []
    try:
        for filePath in searchPath.rglob('*'):
            if not filePath.is_file():
                continue
            try:
                if filePath.stat().st_size > _MAXFileSize:
                    continue
                text = filePath.read_text('utf-8', errors='replace')
                for i, line in enumerate(text.split('\n'), 1):
                    if query.lower() in line.lower():
                        rel = filePath.relative_to(searchPath)
                        results.append(f'{rel}:{i}:{line[:200].strip()}')
                        if len(results) >= _MAXSearchResults:
                            break
            except (UnicodeDecodeError, OSError):
                continue
        return '\n'.join(results) if results else 'No matches found.'
    except Exception as exc:
        return f'Error during search: {exc}'


def _queue_sandbox_escape(session: object, command: str, denial: str) -> None:
    """Create an ApprovalBanner pending mutation for unsandboxed retry."""
    try:
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


async def _runCommand(command: str) -> str:
    """Run a shell command inside the Codex-like sandbox."""
    firstWord = command.strip().split()[0].lower() if command.strip() else ''
    if firstWord.endswith('.exe'):
        firstWord = firstWord[:-4]
    if firstWord not in _ALLOWEDCommandPrefixes and (not command.startswith('./')):
        return f"Error: Command '{firstWord}' is not in the allowed list."
    dangerous = ['rm -rf /', 'rm -rf ~', ':(){ :|:& };:', 'dd if=', '> /dev/', 'mkfs.']
    for pattern in dangerous:
        if pattern in command:
            return f'Error: Command contains dangerous pattern: {pattern}'

    session = _session()
    allow_unsandboxed = False
    if session is not None:
        try:
            from app.services.workbench.workbench import has_tool_grant

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

    result = await run_sandboxed(command, policy, timeout=float(_MAXCommandTimeout))
    if result.denial_reason and session is not None and not allow_unsandboxed:
        _queue_sandbox_escape(session, command, result.denial_reason)
    return result.as_tool_text()


def register() -> None:
    """Register file and shell tools."""
    tool_registry.register(
        'read_file',
        'Read a file from the filesystem. Path must be absolute (or relative to workspace). Max ~10 MB. Sandboxed to the session workspace when set.',
        _readFile,
        {
            'type': 'object',
            'properties': {'path': {'type': 'string', 'description': 'Absolute path to the file to read.'}},
            'required': ['path'],
        },
    )
    tool_registry.register(
        'write_file',
        'Write content to a file, overwriting any existing content. Creates parent directories if needed. Sandboxed to the session workspace.',
        _writeFile,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Absolute path to the file to write.'},
                'content': {'type': 'string', 'description': 'The content to write.'},
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
        'Run a shell command inside the session sandbox (workspace-write by default, network off). Allowed prefixes include git, python, npm, node, pytest, uv, … Timeout 300s.',
        _runCommand,
        {
            'type': 'object',
            'properties': {'command': {'type': 'string', 'description': 'The command to execute.'}},
            'required': ['command'],
        },
    )
