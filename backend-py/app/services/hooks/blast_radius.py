"""Blast-radius scoring hook — scores change impact after file writes.

POST_TOOL_USE on write_file|edit_file|create_file. Non-blocking.
Emits a blastRadius SSE data payload with score 0-100.
"""

from __future__ import annotations

import asyncio
import glob
import os
import re

from app.services.hooks.registry import HookRegistry
from app.services.hooks.types import HookContext, HookEvent, HookResult

# Paths considered "core" (higher risk)
CORE_PATHS = ('app/routers/', 'app/adapters/', 'app/services/sandbox/', 'app/lib/', 'app/providers/')

# Scanning caps: the workspace walk must stay bounded so a huge repo cannot
# stall the event loop (or the 5s hook timeout) — run inside to_thread anyway.
_MAX_SCAN_DEPTH = 8
_MAX_SCAN_FILES = 2000
_SKIP_DIRS = ('.venv', 'node_modules', '.git', '__pycache__', '.archive')

_IMPORT_RE = re.compile(r'(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))')


def _is_core_path(file_path: str) -> bool:
    """Check if a file is in a core path."""
    normalized = file_path.replace('\\', '/')
    return any(cp in normalized for cp in CORE_PATHS)


def _has_test_file(file_path: str, workspace: str | None) -> bool:
    """Check if a corresponding test file exists."""
    if not workspace:
        return False
    stem = os.path.splitext(os.path.basename(file_path))[0]
    # Python conventions
    candidates = [
        os.path.join(workspace, 'tests', f'test_{stem}.py'),
        os.path.join(workspace, 'tests', f'{stem}_test.py'),
        # TypeScript conventions — '**' must be resolved as a real glob,
        # os.path.exists on a literal '**' never matches.
        os.path.join(workspace, 'src', '**', f'{stem}.test.ts'),
        os.path.join(workspace, 'src', '**', f'{stem}.test.tsx'),
    ]
    for c in candidates:
        if '**' in c:
            if glob.glob(c, recursive=True):
                return True
        elif os.path.exists(c):
            return True
    return False


def _count_importers(file_path: str, workspace: str | None) -> int:
    """Count files that import this module (rough grep).

    Synchronous and bounded (depth + file caps) — callers inside the async
    hook run it via ``asyncio.to_thread`` so ``asyncio.wait_for`` can still
    cancel a runaway scan.
    """
    if not workspace:
        return 0
    stem = os.path.splitext(os.path.basename(file_path))[0]
    count = 0
    scanned = 0
    # Scan Python files for imports of this module
    for root, dirs, files in os.walk(workspace):
        # Prune skip dirs instead of re-testing every root substring
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        depth = root[len(workspace):].count(os.sep)
        if depth > _MAX_SCAN_DEPTH:
            dirs[:] = []
            continue
        for fname in files:
            if scanned >= _MAX_SCAN_FILES:
                return count
            scanned += 1
            if not fname.endswith(('.py', '.ts', '.tsx')):
                continue
            fpath = os.path.join(root, fname)
            if fpath == file_path:
                continue
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read(8192)  # First 8KB only
                if re.search(rf'(?:from|import)\s+.*\b{re.escape(stem)}\b', content):
                    count += 1
            except OSError:
                continue
        if count >= 30:  # Cap scanning
            return count
    return count


def compute_blast_radius(file_path: str, workspace: str | None) -> tuple[int, list[str]]:
    """Compute blast radius score (0-100) and reasons."""
    score = 10  # Base: any file write
    reasons: list[str] = []

    if _is_core_path(file_path):
        score += 20
        reasons.append('core path')

    importers = _count_importers(file_path, workspace)
    if importers > 0:
        score += min(importers * 5, 30)
        reasons.append(f'{importers} importers')

    if not _has_test_file(file_path, workspace):
        score += 15
        reasons.append('no test file')

    # File complexity proxy: check line count
    try:
        if os.path.exists(file_path):
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = sum(1 for _ in f)
            if lines > 300:
                score += 15
                reasons.append(f'{lines} lines')
    except OSError:
        pass

    # Security patterns in path
    if re.search(r'(auth|permission|secret|token|security)', file_path, re.I):
        score += 10
        reasons.append('security-related')

    return min(score, 100), reasons


async def _score_blast_radius(ctx: HookContext) -> HookResult:
    """Score blast radius after a file write."""
    file_path = ''
    if ctx.tool_args:
        file_path = str(ctx.tool_args.get('path', '') or ctx.tool_args.get('file_path', '') or '')
    if not file_path:
        return HookResult(action='allow')

    # Run the workspace scan off the event loop so the 5s hook timeout can
    # actually interrupt a slow/bounded walk (wait_for cannot cancel sync code).
    score, reasons = await asyncio.to_thread(compute_blast_radius, file_path, ctx.workspace_path)

    level = 'info' if score < 40 else 'warning' if score < 60 else 'high'
    message = None
    if score >= 80:
        message = f'High blast radius ({score}/100). Consider running tests before continuing.'
    elif score >= 60:
        message = f'Elevated blast radius ({score}/100): {", ".join(reasons)}.'

    return HookResult(
        action='allow',
        message=message,
        data={
            'type': 'blastRadius',
            'score': score,
            'file': file_path,
            'reasons': reasons,
            'level': level,
        },
    )


def register(reg: HookRegistry) -> None:
    """Register blast-radius scoring hook."""
    reg.register(
        'blast_radius', HookEvent.POST_TOOL_USE, _score_blast_radius,
        matcher='write_file|edit_file|create_file', priority=50,
    )
