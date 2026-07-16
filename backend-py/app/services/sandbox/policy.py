"""Sandbox policy types — Codex-aligned modes, orthogonal to Plan/Ask/Full."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final, Literal

SandboxMode = Literal['read-only', 'workspace-write', 'danger-full-access']
EnforcementBackend = Literal[
    'windows-appcontainer',
    'seatbelt',
    'landlock',
    'bwrap',
    'soft',
]

DEFAULT_SANDBOX_MODE: Final[SandboxMode] = 'workspace-write'
VALID_SANDBOX_MODES: Final[frozenset[str]] = frozenset(
    {'read-only', 'workspace-write', 'danger-full-access'}
)

# Soft-layer network denial (when policy.network is False).
NETWORK_COMMAND_PREFIXES: Final[frozenset[str]] = frozenset(
    {
        'curl',
        'wget',
        'http',
        'https',
        'ssh',
        'scp',
        'sftp',
        'ftp',
        'nc',
        'ncat',
        'netcat',
        'telnet',
        'ping',
        'nmap',
        'dig',
        'nslookup',
        'aria2c',
        'fetch',
    }
)

# Mutating shell prefixes blocked in read-only mode.
READ_ONLY_BLOCKED_PREFIXES: Final[frozenset[str]] = frozenset(
    {
        'rm',
        'rmdir',
        'mv',
        'cp',
        'mkdir',
        'touch',
        'chmod',
        'chown',
        'tee',
        'dd',
        'truncate',
        'mkfs',
        'npm',
        'npx',
        'pip',
        'cargo',
        'docker',
        'podman',
    }
)


def normalize_sandbox_mode(mode: str | None) -> SandboxMode:
    raw = (mode or '').strip().lower().replace('_', '-')
    aliases = {
        'readonly': 'read-only',
        'read': 'read-only',
        'workspace': 'workspace-write',
        'workspacewrite': 'workspace-write',
        'full': 'danger-full-access',
        'danger': 'danger-full-access',
        'danger-full': 'danger-full-access',
        'unsandboxed': 'danger-full-access',
    }
    mapped = aliases.get(raw, raw)
    if mapped in VALID_SANDBOX_MODES:
        return mapped  # type: ignore[return-value]
    return DEFAULT_SANDBOX_MODE


@dataclass(frozen=True)
class SandboxPolicy:
    """Effective sandbox policy for one tool invocation."""

    mode: SandboxMode = DEFAULT_SANDBOX_MODE
    workspace_root: str = ''
    network: bool = False
    writable_roots: tuple[str, ...] = field(default_factory=tuple)
    allow_unsandboxed: bool = False

    @property
    def is_full_access(self) -> bool:
        return self.mode == 'danger-full-access' or self.allow_unsandboxed

    @property
    def is_read_only(self) -> bool:
        return self.mode == 'read-only' and not self.allow_unsandboxed


@dataclass
class SandboxResult:
    """Outcome of a sandboxed (or soft) command run."""

    ok: bool
    stdout: str = ''
    stderr: str = ''
    exit_code: int | None = None
    denial_reason: str | None = None
    enforcement: EnforcementBackend = 'soft'
    sandboxed: bool = True
    elapsed_ms: int = 0

    def as_tool_text(self) -> str:
        if self.denial_reason:
            tag = f'[sandbox:{self.enforcement}]'
            return (
                f'{tag} Blocked: {self.denial_reason}\n'
                'Ask the user to approve unsandboxed execution (Once / This chat / Always), '
                'or switch sandbox mode to Full access.'
            )
        parts: list[str] = []
        if self.stdout:
            parts.append(self.stdout)
        if self.stderr:
            parts.append(f'STDERR:\n{self.stderr}')
        if self.exit_code not in (None, 0):
            parts.append(f'Exit code: {self.exit_code}')
        body = '\n'.join(parts) if parts else '(no output)'
        badge = 'sandboxed' if self.sandboxed and not self.is_full_marker() else 'unsandboxed'
        return f'[sandbox:{self.enforcement}|{badge}] {body}'

    def is_full_marker(self) -> bool:
        return self.enforcement == 'soft' and not self.sandboxed
