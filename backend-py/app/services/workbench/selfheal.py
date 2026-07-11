"""
Self-healing logic — detects common tool errors and appends hints so the
model can fix them automatically.

Port of backend/services/workbench/selfheal.js (214 lines).
"""

from __future__ import annotations
import re

ERROR_PATTERNS = [
    'error:',
    'exit code',
    'command not found',
    'not recognized as',
    'cannot find path',
    'no such file or directory',
    'permission denied',
    'access is denied',
    'syntax error',
    'browser.use.*(?:not found|not installed|missing)',
]
BASH_IN_POWERSHELL_COMMANDS = [
    'grep',
    'ls',
    'cat',
    'rm',
    'chmod',
    'chown',
    'sudo',
    'apt',
    'apt-get',
    'yum',
    'dnf',
    'brew',
    'curl',
    'wget',
    'sed',
    'awk',
    'sort',
    'uniq',
    'wc',
    'head',
    'tail',
    'cut',
    'tr',
    'diff',
    'find',
    'xargs',
    'which',
    'make',
    'gcc',
    'g++',
    'python3',
    'pip3',
    'rsync',
    'scp',
    'ssh',
]
POWERSHELL_CMD_PATTERN = re.compile(
    '\\b(Get-ChildItem|Select-Object|Where-Object|ForEach-Object|Write-Output|Write-Host|Out-File|Set-Content|Add-Content|Get-Content|Remove-Item|New-Item|Copy-Item|Move-Item|Test-Path|Join-Path|Split-Path|Resolve-Path)\\b'
)


def detectError(content: str) -> bool:
    """Check if tool result content contains error patterns."""
    if not isinstance(content, str):
        return False
    lower = content.lower()
    return any((re.search(pattern, lower) for pattern in ERROR_PATTERNS))


def buildHints(content: str) -> str:
    """Generate context-aware hints based on the error content."""
    hints: list[str] = []
    if 'browser' in content.lower() and ('not found' in content.lower() or 'not installed' in content.lower()):
        hints.append(
            'Hint: The browser-use MCP server may not be installed. Try: pip install browser-use playwright && playwright install chromium'
        )
    firstWord = content.strip().split()[0].lower() if content.strip() else ''
    if firstWord in BASH_IN_POWERSHELL_COMMANDS:
        hints.append(
            f"Hint: '{firstWord}' is a Unix/Linux command that may not work in Windows PowerShell. If running on Windows, try the PowerShell equivalent or check if this environment has Git Bash/WSL."
        )
    psMatch = POWERSHELL_CMD_PATTERN.search(content)
    if psMatch:
        psCmd = psMatch.group(0)
        hints.append(
            f"Hint: '{psCmd}' is a PowerShell cmdlet. This environment may be running bash, not PowerShell. Use the Unix/Linux equivalent instead."
        )
    if 'not recognized' in content.lower():
        hints.append(
            'Hint: This error typically means the command is not available on this system. Check the command spelling or try an alternative approach.'
        )
    if '\\' in content and ('no such file' in content.lower() or 'cannot find' in content.lower()):
        hints.append(
            "Hint: File paths may use forward slashes (/) instead of backslashes (\\). Try using '/' as the path separator."
        )
    if 'permission denied' in content.lower() or 'access is denied' in content.lower():
        hints.append(
            "Hint: The operation requires elevated permissions. Try using a different location or approach that doesn't require special permissions."
        )
    if not hints:
        hints.append(
            'Hint: The tool returned an error. Check the parameters and try again. If the issue persists, try a different approach.'
        )
    return '\n\n' + '\n'.join(hints)


def enhanceToolResult(content: str) -> str:
    """Enhance a tool result by appending self-healing hints if an error is detected."""
    if not detectError(content):
        return content
    hints = buildHints(content)
    return content + hints


def applySelfHealToMessages(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    """Apply self-healing to all tool result messages in a conversation."""
    if not messages:
        return messages
    updated = list(messages)
    for i, msg in enumerate(updated):
        if msg.get('role') != 'tool':
            continue
        content = msg.get('content', '')
        if isinstance(content, str) and detectError(content):
            updated[i] = dict(msg)
            updated[i]['content'] = enhanceToolResult(content)
    return updated
