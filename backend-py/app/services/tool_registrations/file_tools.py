"""File and shell tool handlers + registration."""

from __future__ import annotations
import asyncio
import os
from pathlib import Path
from app.services import tool_registry

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
]


async def _readFile(path: str) -> str:
    """Read a file from the filesystem."""
    filePath = Path(path).resolve()
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
    """Write content to a file."""
    filePath = Path(path).resolve()
    try:
        filePath.parent.mkdir(parents=True, exist_ok=True)
        import aiofiles

        async with aiofiles.open(str(filePath), 'w', encoding='utf-8') as f:
            await f.write(content)
        return f'Successfully wrote {len(content)} bytes to {path}'
    except Exception as exc:
        return f'Error writing file: {exc}'


async def _listDirectory(path: str) -> str:
    """List files and directories."""
    dirPath = Path(path).resolve()
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
    """Search file contents using ripgrep or fallback grep."""
    searchPath = Path(path).resolve()
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
    except Exception as exc:
        return f'Error searching files: {exc}'


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


async def _runCommand(command: str) -> str:
    """Run a shell command with safety checks."""
    firstWord = command.strip().split()[0].lower() if command.strip() else ''
    if firstWord not in _ALLOWEDCommandPrefixes and (not command.startswith('./')):
        return f"Error: Command '{firstWord}' is not in the allowed list."
    dangerous = ['rm -rf /', 'rm -rf ~', ':(){ :|:& };:', 'dd if=', '> /dev/', 'mkfs.']
    for pattern in dangerous:
        if pattern in command:
            return f'Error: Command contains dangerous pattern: {pattern}'
    try:
        proc = await asyncio.create_subprocess_shell(
            command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=os.getcwd()
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_MAXCommandTimeout)
        resultParts = []
        if stdout:
            resultParts.append(stdout.decode('utf-8', errors='replace'))
        if stderr:
            resultParts.append(f'STDERR:\n{stderr.decode("utf-8", errors="replace")}')
        if proc.returncode != 0:
            resultParts.append(f'Exit code: {proc.returncode}')
            if not resultParts:
                resultParts.append(f'Command failed with exit code {proc.returncode}')
        return '\n'.join(resultParts) if resultParts else '(no output)'
    except asyncio.TimeoutError:
        return f'Error: Command timed out after {_MAXCommandTimeout}s'
    except Exception as exc:
        return f'Error executing command: {exc}'



def register() -> None:
    """Register file and shell tools."""
    tool_registry.register(
        'read_file',
        'Read a file from the filesystem. Path must be absolute. Max file size ~10 MB.',
        _readFile,
        {
            'type': 'object',
            'properties': {'path': {'type': 'string', 'description': 'Absolute path to the file to read.'}},
            'required': ['path'],
        },
    )
    tool_registry.register(
        'write_file',
        'Write content to a file, overwriting any existing content. Creates parent directories if needed.',
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
        'List files and directories in a given path (absolute). Output shows dir/file prefix, size, and name.',
        _listDirectory,
        {
            'type': 'object',
            'properties': {'path': {'type': 'string', 'description': 'Absolute path to the directory.'}},
            'required': ['path'],
        },
    )
    tool_registry.register(
        'search_files',
        'Search file contents using ripgrep or fallback grep. Case-insensitive. Path defaults to current directory.',
        _searchFiles,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'The text to search for.'},
                'path': {'type': 'string', 'description': 'Directory to search in (default: current).'},
            },
            'required': ['query'],
        },
    )
    tool_registry.register(
        'run_command',
        'Run a shell command. Allowed commands: git, python, npm, node, npx, ls, cat, less, head, tail, wc, echo, mkdir, cp, mv, rm, rmdir, chmod, curl, wget, jq, sed, awk, grep, sort, uniq, date, whoami, pwd, cd, source, export, which, make, cargo, pip, deno, bun, go, rustc, clang, gcc, bash, zsh, sh. Timeout 300s.',
        _runCommand,
        {
            'type': 'object',
            'properties': {'command': {'type': 'string', 'description': 'The command to execute.'}},
            'required': ['command'],
        },
    )
