"""Swappable filesystem + subprocess world (DeepSeek capability seam).

Tools bind paths and run commands through ``get_world()``. Point this at a
remote sandbox without forking every file/shell tool.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.sandbox.policy import SandboxPolicy, SandboxResult


class ExecutionWorld:
    """Default world: local workspace bind + sandboxed subprocess."""

    def bind_path(self, path: str, workspace: str, *, for_write: bool = False):
        from app.services.sandbox import bind_path as _bind

        return _bind(path, workspace, for_write=for_write)

    async def run_sandboxed(self, command: str, policy: 'SandboxPolicy', *, timeout: float = 300.0) -> 'SandboxResult':
        from app.services.sandbox import run_sandboxed as _run

        return await _run(command, policy, timeout=timeout)


_world: ExecutionWorld | None = None


def get_world() -> ExecutionWorld:
    global _world
    if _world is None:
        _world = ExecutionWorld()
    return _world


def set_world(world: ExecutionWorld | None) -> None:
    """Install a replacement world (tests / remote sandbox). None restores default."""
    global _world
    _world = world


def bind_path(path: str, workspace: str, *, for_write: bool = False) -> tuple[Path | None, str | None]:
    return get_world().bind_path(path, workspace, for_write=for_write)


async def run_sandboxed(command: str, policy: 'SandboxPolicy', *, timeout: float = 300.0) -> 'SandboxResult':
    return await get_world().run_sandboxed(command, policy, timeout=timeout)
